import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from prepare import prepare, verify_integrity


class EvidencePreparationTests(unittest.TestCase):
    def setUp(self):
        self.bundle = json.loads((ROOT / "fixtures/signals.json").read_text())

    def test_duplicate_effect_detected_but_log_replay_and_installments_not_flagged(self):
        p = prepare(self.bundle)
        self.assertEqual([(f["tenant_id"], f["invoice_id"], f["payment_ids"]) for f in p["findings"]],
                         [("tenant_alder", "INV-1042", ["PAY-001", "PAY-002"])])
        self.assertIn("JIRA-BILL-142", p["findings"][0]["source_ids"])
        self.assertIn("EVT-002", p["findings"][0]["source_ids"])

    def test_does_not_claim_cause_verification_or_approval(self):
        p = prepare(self.bundle)
        self.assertIn("unconfirmed", p["findings"][0]["cause"])
        self.assertEqual(p["status"], "awaiting_rule_review")
        self.assertIsNone(p["rule_proposal"]["reviewer"])
        self.assertEqual(p["release"]["status"], "blocked_unverified")
        self.assertIsNone(p["release"]["approved_artifact"])

    def test_repeated_inputs_produce_identical_proposal(self):
        self.assertEqual(prepare(self.bundle), prepare(copy.deepcopy(self.bundle)))

    def test_changed_source_or_expectation_invalidates_integrity(self):
        p = prepare(self.bundle)
        self.assertTrue(verify_integrity(p, self.bundle))
        p["rule_proposal"]["expected"] = "two payments allowed"
        self.assertFalse(verify_integrity(p, self.bundle))
        p = prepare(self.bundle)
        self.bundle["policies"][0]["version"] += 1
        self.assertFalse(verify_integrity(p, self.bundle))

    def test_policy_required_and_non_synthetic_input_rejected(self):
        self.bundle["policies"] = []
        with self.assertRaises(ValueError): prepare(self.bundle)
        self.bundle["synthetic"] = False
        with self.assertRaises(ValueError): prepare(self.bundle)

    def test_same_invoice_number_other_tenant_is_independent(self):
        x = copy.deepcopy(self.bundle["payment_audit"][0])
        x.update(id="AUD-OTHER", payment_id="PAY-OTHER", tenant_id="tenant_other")
        self.bundle["payment_audit"].append(x)
        self.assertEqual(len(prepare(self.bundle)["findings"]), 1)

    def test_conflicting_effect_values_are_not_silently_deduplicated(self):
        self.bundle["payment_audit"][3]["amount_minor"] += 1
        with self.assertRaisesRegex(ValueError, "Conflicting"): prepare(self.bundle)


if __name__ == "__main__": unittest.main()
