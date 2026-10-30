#!/usr/bin/env python3
"""Fresh-process receipt readback and malformed-evidence rejection controls.

This uses the existing gate. It does not authenticate arbitrary operator-edited
receipts or certify that editable local JSON is tamper-proof.
"""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

p=argparse.ArgumentParser();p.add_argument('--evidence',required=True);p.add_argument('--engine-root',required=True);a=p.parse_args()
root=Path(a.evidence);engine=Path(a.engine_root)
sys.path[:0]=[str(engine),str(engine/'backend')]
from verification_factory.comparison import compare_control_receipts
receipts={leg:json.loads((root/leg/'receipt.json').read_text()) for leg in ['healthy','broken','repaired']}
contract=json.loads((root/'contract.json').read_text());expected=frozenset(c['id'] for c in contract['cases'])
def compare(r):return compare_control_receipts(r['healthy'],r['broken'],r['repaired'],expected_cases=expected,scope=contract['scope'])
controls=[]
def check(name,result):
    controls.append({'name':name,'passed':bool(result)})
    if not result:raise AssertionError(name)
check('fresh_process_original_evidence_admitted',compare(receipts)['gate']['green_allowed'] is True)
def reject(name,change):
    r=deepcopy(receipts);change(r);check(name,compare(r)['gate']['green_allowed'] is False)
reject('missing_case_refused',lambda r:r['repaired']['cases'].pop())
reject('contract_change_refused',lambda r:r['repaired'].update(contract_sha256='changed'))
reject('observer_change_refused',lambda r:r['repaired'].update(assertion_implementation_sha256='changed'))
reject('setup_exit_not_pass',lambda r:r['repaired'].update(exit_code=2))
reject('cleanup_not_confirmed',lambda r:r['repaired'].pop('cleanup'))
reject('external_network_refused',lambda r:r['repaired']['runtime'].update(internal_network=False))
reject('host_mount_refused',lambda r:r['repaired']['runtime'].update(host_mounts=[{'Type':'bind','Source':'/host'}]))
reject('published_port_refused',lambda r:r['repaired']['runtime'].update(published_ports={'8080/tcp':[{}]}))
reject('non_boolean_case_refused',lambda r:r['repaired']['cases'][0].update(held='true'))
reject('inconsistent_exit_refused',lambda r:r['broken'].update(exit_code=0))
out={'scope':'fresh-process readback plus scoped rejection controls; not cryptographic attestation',
     'controls':controls,'receipt_sha256':{leg:hashlib.sha256((root/leg/'receipt.json').read_bytes()).hexdigest() for leg in receipts},
     'proof_gate_sha256':hashlib.sha256((engine/'backend/app/flows/proof_gate.py').read_bytes()).hexdigest(),
     'comparison_implementation_sha256':hashlib.sha256((engine/'verification_factory/comparison.py').read_bytes()).hexdigest()}
(root/'fresh-process-readback.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
