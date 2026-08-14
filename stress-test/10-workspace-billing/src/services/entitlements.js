const db = require('./db');

async function grantSeats(workspaceId, seats, { provider, reference }) {
  if (!workspaceId) return;
  const n = Number(seats) || 1;

  await db.query(
    `insert into workspace_seats (workspace_id, seats, source, source_ref, granted_at)
     values ($1, $2, $3, $4, now())`,
    [workspaceId, n, provider, reference],
  );

  await db.query(
    `update workspaces set seat_limit = seat_limit + $2, status = 'active'
     where id = $1`,
    [workspaceId, n],
  );
}

async function revokeSeats(workspaceId, { provider }) {
  if (!workspaceId) return;
  await db.query(
    `update workspaces set seat_limit = 0, status = 'inactive' where id = $1`,
    [workspaceId],
  );
  await db.query(
    `delete from workspace_seats where workspace_id = '${workspaceId}' and source = '${provider}'`,
  );
}

module.exports = { grantSeats, revokeSeats };
