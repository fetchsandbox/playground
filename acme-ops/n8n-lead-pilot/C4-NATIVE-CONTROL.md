# C4 blind resend — actual native negative control caught

The [negative-control receipt](https://fetchsandbox.com/runs/8e2fa15525?flow=vr_758094bf2b174147bcb99822da7cb093)
records **seven checks held, one violated, six unmeasured; overall failing**.
C4 failed with `Accepted response read-back repeated the provider write`.
This closes the earlier missing native C4 negative-control measurement; it does
not close the remaining pilot quality gates.

## What was deliberately wrong

The explicitly registered `blind-gmail-resend` source variant replaces an
uncertain Gmail lookup with another send. It is selected by workflow publication,
not a check ID, lead ID or scenario-specific answer. The shared C7 validator and
all frozen business checks were preserved. Only the decision-node source changed.
No real Gmail inbox, calendar invitations or Slack delivery was used.

Actual native version: `875af695-d8cb-406f-a47e-1e96dca52d4f`.
Actual export SHA256:
`4fb0d615a05c89903b646de6789bb5f1b5967c3b29173429851d2bc7c5bd439e`.
The source guard accepted this export only with the explicit variant. Native
execution 151 separately named that version in its UI history link.

The first C4 execution reported unknown after the accepted send lost its response.
A later execution reported confirmed after sending again. The engine rejected
the repeated write; a later independent Gmail collection in **this same run**
contained two messages with two distinct IDs for the C4 lead. The same oracle was
not weakened to make the negative version pass.

C4 failed before its provider-state assertion phase. The run recorded 35
provider-state assertions, all held, for the other measured checks. That count
must not be described as 45 assertions or as every case passing. C5 was unmeasured:
the mutant skipped the required lookup fault observation. Its two modeled messages
are visible, but this does not establish a qualified unavailable-readback control.

[Sanitized negative observation](evidence/2026-11-07-c4-native-negative-observation.json).
Four owned twins were deleted with HTTP 200; the retained owner snapshot still
returned HTTP 200 and the temporary binding file was removed.

## Restoration and fresh remeasurement

The exact corrected normal decision source was republished as
`0397f00d-f536-4975-935b-fb705b780055`, with C7 preserved. n8n's Version history
marks it Published at November 7, 18:59:22 Pacific. The Mac relocked at the latest
native export Save dialog. The actual prior normal export (`2b310b22`, SHA256
`9364f3dbdd9be37bbd188ada820c1869cd88d304768a43c4f3440785bef6060a`) was reused
unchanged for source registration in a fresh normal run. It was not relabeled or
edited to claim a newly captured export. Current source/version observation and
that declared historical export metadata are separate evidence.

The [fresh restored receipt](https://fetchsandbox.com/runs/68783d0529?flow=vr_93d192ffcd8c4c0298711534d4b3192b)
has **nine checks held, five unmeasured; overall inconclusive**. All 45 independent
provider-state assertions held. C4 recovered the original accepted message and
kept exactly one distinct Gmail message; C5 kept one message while lookup was
unavailable. C7 again returned ten HTTP 400s with no matching effects. Actual
native C4 recovery execution 177 separately named restored version `0397f00d`
in the UI; completed replay execution 191 named the same version.

The [restored observation](evidence/2026-11-07-c4-c7-restored-observation.json)
records the separate result. Its business-check definition hash matches the
negative run. Four owned twins were deleted with HTTP 200, the owner snapshot
remained readable with HTTP 200, temporary bindings were removed, and the owned
app/ngrok listeners were stopped. The actual restored native export was subsequently saved through the native
export/Save flow: version `0397f00d-f536-4975-935b-fb705b780055`, active true,
six nodes, SHA256 `28dd4054ebe1986ff2d4e232baa0d70898a6efa3f5f7d3740300514bd13712d4`. The existing
normal source guard passed for its parameters, credentials and wiring. This
closes the latest-export capture gap as a later source observation; it does not
change the export hash declared in the already-recorded behavioral run.

The [earlier C7 normal receipt](https://fetchsandbox.com/runs/65f5fcf6f9?flow=vr_d8a77b680e2c4d4b80da36395e709f87)
is a separate run: nine checks held, five unmeasured and all 45 independent
provider-state assertions held. Do not merge the receipts into one result.
