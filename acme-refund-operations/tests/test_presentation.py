"""Customer communication must explain the outcome without leaking diagnostic identifiers."""
import copy,json
import pytest
from refund_ops import presentation

@pytest.fixture
def case():
    return {'case_id':'GMAIL-8c9a6a74-f1cb-4a27-afcb-2c218891a521','run_id':'refund-071c7913473843468146f824228695f4',
        'input':{'customerEmail':'customer@example.test','channel':'email','paymentIntent':'pi_PRIVATE_REFERENCE','requestedPct':'20'},
        'product':{'name':'Acme Edge Reliability Gateway','sku':'ACME-EDGE-100'},
        'policy_display':{'approval_from_pct':20,'max_refund_pct':70,'version':'2026-10-17.1'},
        'assessment':{'amount_minor':20000,'paid_minor':100000,'currency':'usd','requested_pct':'20','reasons':['requested_percentage_above_company_cap']},
        'refund':{'amount_minor':20000,'currency':'usd','provider_id':'re_PRIVATE_REFERENCE'},'notifications':{},
        'approval':{'actor':'MANAGER','decision':'approve'}}

@pytest.mark.parametrize('outcome',list(presentation.TITLES))
def test_all_outcomes_use_product_amount_and_short_reference_not_machine_ids(case,outcome):
    view=presentation.render(case,outcome);text=json.dumps(view)
    for private in [case['case_id'],case['run_id'],case['input']['paymentIntent'],case['refund']['provider_id']]:assert private not in text
    assert 'Acme Edge Reliability Gateway' in view['email'] and '$200.00 USD' in view['slack']
    assert view['reference'].startswith('RF-') and len(view['reference'])==11
    assert view['subject'].startswith('Acme refund') and '\n\n' in view['email']

def test_manager_card_explains_amount_conditions_and_next_action(case):
    text=presentation.approval(case)
    for required in ['$200.00 USD','20% of $1,000.00 USD','20% through 70%','approve or decline within 24 hours','customer@example.test']:assert required in text
    assert case['case_id'] not in text and 'pi_' not in text

def test_pending_and_failure_never_claim_completed_refund(case):
    for outcome in ['REFUND_PENDING','REFUND_FAILED','HELD']:
        text=presentation.render(case,outcome)['email']
        assert 'Your refund of $200.00 USD for Acme Edge Reliability Gateway is complete' not in text
    assert 'has not confirmed completion yet' in presentation.render(case,'REFUND_PENDING')['email']

def test_missing_assessment_does_not_invent_an_amount_or_product(case):
    case.pop('assessment');case.pop('refund');case.pop('product');view=presentation.render(case,'HELD')
    assert '$0.00' not in view['email']+view['slack'] and 'your purchase' in view['email']

def test_reference_is_stable_and_distinct_between_cases(case):
    same=presentation.reference(case);other=copy.deepcopy(case);other['case_id']='different-case'
    assert presentation.reference(case)==same and presentation.reference(other)!=same
