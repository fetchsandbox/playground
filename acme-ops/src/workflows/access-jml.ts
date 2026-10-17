import { z } from "zod";
import { FatalError, ProviderError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, out, plain } from "./shared";

// IT org · it-identity team.
// Trigger: an HR system event (joiner / mover / leaver) forwarded by the control plane.
// Directory: WorkOS User Management (ACME's stand-in for Okta / Entra ID).

const Role = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "role slug like engineer or finance-admin");

const Input = z
  .object({
    type: z.enum(["joiner", "mover", "leaver"]),
    employee: z.object({ email: Email, firstName: z.string().min(1).max(100), lastName: z.string().max(100).optional(), department: z.string().min(1).max(100) }),
    organizationId: z.string().min(1).max(100),
    /** Target roles after the event (empty for a leaver). */
    roles: z.array(Role).max(20).default([]),
    /** Roles held before a move. */
    previousRoles: z.array(Role).max(20).default([]),
    managerChannel: ChannelId,
    itWorkspace: z.string().min(1).default("acme-it"),
    approvers: Approvers,
  })
  .refine((i) => i.type === "leaver" || i.roles.length > 0, { message: "joiners and movers need at least one role", path: ["roles"] });
type Input = z.infer<typeof Input>;

/** Roles that grant admin or money-moving power: always need a human. */
export const PRIVILEGED = new Set(["admin", "it-admin", "security-admin", "finance-admin", "billing-admin"]);
/** Pairs one person must never hold together (segregation of duties). */
export const SOD_CONFLICTS: [string, string][] = [
  ["finance-admin", "it-admin"],
  ["billing-admin", "security-admin"],
];

export function sodViolations(roles: string[]): string[] {
  return SOD_CONFLICTS.filter(([a, b]) => roles.includes(a) && roles.includes(b)).map(([a, b]) => `${a}+${b}`);
}

interface Directory {
  userId?: string;
  memberships: { id: string; role: string }[];
}

const isNotFound = (err: unknown) => err instanceof ProviderError && err.status === 404;

export const accessJml: WorkflowDef<Input> = {
  id: "access-jml",
  title: "Joiner, mover, leaver access",
  org: "IT",
  team: "it-identity",
  description:
    "Turn an HR joiner/mover/leaver event into directory changes: create the account and standard roles, open the IT ticket and tell the manager. Privileged roles, role removals and deprovisioning wait for approval; reconcile proves a leaver's account is gone.",
  input: Input,
  agents: [
    {
      name: "directory-lookup",
      needs: ["workos"],
      async run({ input, providers }) {
        const workos = providers.workos!;
        const user = await workos.findUserByEmail(input.employee.email);
        // Membership listing is best effort: a directory that can't list them returns none.
        const memberships = user ? (await workos.listMemberships(user.id)).filter((m) => m.status !== "inactive").map((m) => ({ id: m.id, role: m.role?.slug ?? "" })) : [];
        const data: Directory = { userId: user?.id, memberships };
        return { summary: user ? `account ${user.id}, ${memberships.length} membership(s)` : "no account", data };
      },
    },
    {
      name: "policy-check",
      needs: [],
      async run({ input }) {
        const violations = sodViolations(input.roles);
        const privileged = input.roles.filter((r) => PRIVILEGED.has(r));
        return { summary: violations.length ? `SoD conflict: ${violations.join(", ")}` : `${privileged.length} privileged role(s)`, data: { violations, privileged } };
      },
    },
  ],

  plan({ input }, results) {
    const dir = out<Directory>(results, "directory-lookup");
    const policy = out<{ violations: string[] }>(results, "policy-check");
    // Without the directory we can't tell what exists; never guess at access changes.
    if (!dir || !policy) return [];
    const { email, firstName, lastName, department } = input.employee;
    const actions: PlannedAction<Input>[] = [];
    const userRef = (applied: Record<string, { ref: string }>) => applied["workos.create_user"]?.ref ?? dir.userId;
    const blockedBySod = new Set(policy.violations.flatMap((v) => v.split("+")));

    if (input.type !== "leaver") {
      if (!dir.userId) {
        actions.push({
          id: "workos.create_user",
          kind: "workos.create_user",
          provider: "workos",
          agent: "directory-lookup",
          gate: "auto",
          summary: { email, department },
          async execute({ providers }) {
            // Re-check at write time: the directory allows duplicate emails.
            const again = await providers.workos!.findUserByEmail(email);
            if (again) return { ref: again.id, detail: { created: false } };
            const u = await providers.workos!.createUser({ email, first_name: firstName, last_name: lastName, external_id: `hr:${email}` });
            return { ref: u.id, detail: { created: true } };
          },
          async reconcile({ providers }, r) {
            try {
              const u = await providers.workos!.getUser(r.ref);
              return u.email?.toLowerCase() === email ? { status: "match" } : { status: "drift", detail: `email is ${u.email}` };
            } catch (err) {
              if (isNotFound(err)) return { status: "missing", detail: "account deleted" };
              throw err;
            }
          },
        });
      }
      const held = new Set(dir.memberships.map((m) => m.role));
      for (const role of input.roles.filter((r) => !held.has(r) && !blockedBySod.has(r))) {
        actions.push({
          id: `workos.grant_role:${role}`,
          kind: "workos.grant_role",
          provider: "workos",
          agent: "policy-check",
          gate: PRIVILEGED.has(role) ? "approval" : "auto",
          summary: { email, role, organizationId: input.organizationId, privileged: PRIVILEGED.has(role) },
          async execute({ providers, applied }) {
            const userId = userRef(applied);
            if (!userId) throw new FatalError("no directory account to grant a role to");
            const m = await providers.workos!.createMembership(userId, input.organizationId, role);
            return { ref: m.id, detail: { userId } };
          },
          async reconcile({ providers }, r) {
            try {
              const m = await providers.workos!.getMembership(r.ref);
              return m.status === "active" ? { status: "match" } : { status: "drift", detail: `membership ${m.status}` };
            } catch (err) {
              if (isNotFound(err)) return { status: "missing", detail: "membership removed" };
              throw err;
            }
          },
        });
      }
      if (input.type === "mover") {
        const target = new Set(input.roles);
        for (const role of input.previousRoles.filter((r) => !target.has(r))) {
          actions.push({
            id: `workos.revoke_role:${role}`,
            kind: "workos.revoke_role",
            provider: "workos",
            agent: "directory-lookup",
            gate: "approval",
            summary: { email, role },
            async execute({ providers }) {
              const m = dir.memberships.find((x) => x.role === role);
              if (!m) throw new FatalError(`no ${role} membership found for ${email}; remove it by hand`);
              await providers.workos!.deleteMembership(m.id);
              return { ref: m.id };
            },
          });
        }
      }
    } else if (dir.userId) {
      const userId = dir.userId;
      actions.push({
        id: "workos.deprovision_user",
        kind: "workos.deprovision_user",
        provider: "workos",
        agent: "directory-lookup",
        gate: "approval",
        summary: { email, userId, removes: "account and every membership" },
        async execute({ providers }) {
          try {
            await providers.workos!.deleteUser(userId);
          } catch (err) {
            if (!isNotFound(err)) throw err; // already gone is the outcome we want
          }
          return { ref: userId };
        },
        async reconcile({ providers }, r) {
          try {
            await providers.workos!.getUser(r.ref);
            return { status: "drift", detail: "account still exists" };
          } catch (err) {
            if (isNotFound(err)) return { status: "match", detail: "account is gone" };
            throw err;
          }
        },
      });
    }

    const checklist =
      input.type === "joiner"
        ? ["Laptop and badge", "GitHub org seat (manual)", "Google Workspace account (manual)", "Slack seat (manual)"]
        : input.type === "leaver"
          ? ["Recover laptop and badge", "Remove GitHub org seat (manual)", "Suspend Google Workspace (manual)", "Deactivate Slack (manual)"]
          : ["Review app access for the new role (manual)"];
    actions.push({
      id: "asana.it_ticket",
      kind: "asana.it_ticket",
      provider: "asana",
      agent: "policy-check",
      gate: "auto",
      summary: { type: input.type, email, items: checklist.length },
      async execute({ providers }) {
        const t = await providers.asana!.createTask({
          name: `${input.type[0]!.toUpperCase()}${input.type.slice(1)}: ${firstName} ${lastName ?? ""} (${department})`.trim(),
          notes: [`Employee: ${email}`, `Roles: ${input.roles.join(", ") || "none"}`, ...(policy.violations.length ? [`SoD conflict held back: ${policy.violations.join(", ")}`] : []), "", ...checklist.map((c) => `[ ] ${c}`)].join("\n"),
          workspace: input.itWorkspace,
        });
        return { ref: t.gid };
      },
      async reconcile({ providers }, r) {
        const t = await providers.asana!.getTask(r.ref);
        return t.name?.includes(firstName) ? { status: "match" } : { status: "drift", detail: "ticket renamed" };
      },
    });

    actions.push({
      id: "slack.notify_manager",
      kind: "slack.notify_manager",
      provider: "slack",
      agent: "policy-check",
      gate: "auto",
      summary: { channel: input.managerChannel, type: input.type },
      async execute({ providers }) {
        const pending = actions.filter((a) => a.gate === "approval").map((a) => a.id.split(":")[1] ?? a.kind);
        const text = [
          `${input.type === "joiner" ? "New starter" : input.type === "mover" ? "Role change" : "Leaver"}: ${plain(`${firstName} ${lastName ?? ""}`, 80)} (${email}, ${plain(department, 60)}).`,
          input.roles.length ? `Roles: ${input.roles.join(", ")}.` : "",
          pending.length ? `Waiting for approval: ${pending.join(", ")}.` : "",
          policy.violations.length ? `Held back for segregation of duties: ${policy.violations.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const m = await providers.slack!.postMessage(input.managerChannel, text);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const dir = out<Directory>(results, "directory-lookup");
    const policy = out<{ violations: string[]; privileged: string[] }>(results, "policy-check");
    return {
      type: input.type,
      email: input.employee.email,
      accountExists: !!dir?.userId,
      directoryRead: !!dir,
      sodViolations: policy?.violations ?? [],
      privilegedRoles: policy?.privileged ?? [],
    };
  },

  catalog: [
    { kind: "workos.create_user", provider: "workos", gate: "auto", description: "Create the directory account for a joiner" },
    { kind: "workos.grant_role", provider: "workos", gate: "auto", description: "Grant a standard role; privileged roles need approval" },
    { kind: "workos.revoke_role", provider: "workos", gate: "approval", description: "Remove a role a mover no longer needs" },
    { kind: "workos.deprovision_user", provider: "workos", gate: "approval", description: "Delete a leaver's account and every membership" },
    { kind: "asana.it_ticket", provider: "asana", gate: "auto", description: "Open the IT checklist ticket (laptop, manual app seats)" },
    { kind: "slack.notify_manager", provider: "slack", gate: "auto", description: "Tell the manager what changed and what awaits approval" },
  ],
};
