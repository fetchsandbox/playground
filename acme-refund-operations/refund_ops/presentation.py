"""Human-facing communication. Canonical case/provider identifiers stay in audit state."""
from decimal import Decimal
from .policy import digest
REVISION='human-refund-v1'

TITLES={'COMPLETED':'Refund completed','REFUND_PENDING':'Refund processing','REFUND_FAILED':'Refund could not be completed',
        'AWAITING_APPROVAL':'Refund awaiting approval','DECLINED':'Refund request declined','REJECTED':'Refund request declined',
        'HELD':'Refund needs a review','EXPIRED':'Refund approval expired'}

def money(amount,currency='usd'):
    value=f'{int(amount)/100:,.2f}';code=currency.upper()
    return ('$'+value+' USD') if code=='USD' else value+' '+code

def percentage(value):
    text=format(Decimal(str(value)),'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text

def reference(case):return 'RF-'+digest({'case':case['case_id']})[:8].upper()

def render(case,outcome,product=None,company=None):
    product=product or case.get('product') or {};company=company or case.get('policy_display') or {}
    name=product.get('name') or 'your purchase';a=case.get('assessment',{});op=case.get('refund',{})
    amount=op.get('amount_minor',a.get('amount_minor'));currency=op.get('currency',a.get('currency','usd'))
    value=money(amount,currency) if amount is not None else 'the requested amount'
    pct=percentage(a.get('requested_pct',case.get('input',{}).get('requestedPct',0)))
    ref=reference(case);heading=TITLES[outcome]
    cap=company.get('max_refund_pct');cap_text=percentage(cap)+'%' if cap is not None else 'the company limit'
    reasons={
        'company_cumulative_refund_cap_exceeded':f'This would take total refunds above {cap_text} of the original payment.',
        'requested_percentage_above_company_cap':f'The requested percentage exceeds {cap_text} allowed by Acme policy.',
        'product_not_refundable':'Completed calibration services are not refundable under this product policy.',
        'outside_product_refund_window':'The product’s refund period has ended.',
        'payment_not_settled':'The payment has not settled.',
        'payment_disputed':'The payment is already under dispute.',
        'usage_exceeds_product_policy':'Recorded product usage exceeds the refund policy’s limit.',
        'amount_exceeds_remaining_paid_balance':'The amount exceeds the remaining refundable payment balance.'}
    explanation=' '.join(dict.fromkeys(reasons.get(x,'The purchase does not meet the applicable refund conditions.') for x in a.get('reasons',[])))
    body={
        'COMPLETED':f'Your refund of {value} for {name} is complete.\n\nIt is going back to your original payment method. Your bank determines when it appears. You do not need to take any further action.',
        'REFUND_PENDING':f'Your refund of {value} for {name} has been initiated. The payment provider has not confirmed completion yet.\n\nWe will confirm the outcome when the refund status is checked again.',
        'REFUND_FAILED':f'We could not complete the refund for {name}. We are not treating it as successful.\n\nAcme Refund Operations needs to review the payment provider’s response before processing can continue.',
        'AWAITING_APPROVAL':f'We checked your purchase and the product’s refund conditions for {name}. Your {pct}% refund request ({value}) needs a manager’s approval under Acme policy.\n\nThe request has been sent for review. No refund has been issued yet.',
        'DECLINED':f'We cannot approve the requested refund for {name}.\n\n{explanation}\n\nNo refund has been issued for this request.',
        'REJECTED':f'An Acme manager declined the requested refund for {name}. No refund has been issued for this request.\n\nContact Acme Refund Operations if you need the decision reviewed.',
        'HELD':f'We need to review the purchase or return details for {name} before we can continue. No refund is being claimed.\n\nAcme Refund Operations needs verified purchase, return or usage evidence to resolve this request.',
        'EXPIRED':f'The manager approval window for {name} expired after 24 hours. No refund has been issued for this request.\n\nContact Acme Refund Operations to have the request reviewed again.'}[outcome]
    email='Hi,\n\n'+body+'\n\nRefund reference: '+ref+'\nAcme Refund Operations'
    subject='Acme '+heading.lower()+' — '+name
    slack=f'*{heading}*\n*Product:* {name}'
    if amount is not None:slack+='\n*Refund amount:* '+value+' ('+pct+'%)'
    if case.get('input',{}).get('channel')=='email':
        slack+='\n*Customer:* '+case['input']['customerEmail']
    summaries={
        'COMPLETED':'Returned to the original payment method. No further action is needed; the bank determines when the credit appears.',
        'AWAITING_APPROVAL':'The purchase and product conditions have been checked. A manager needs to approve this request. No refund has been issued yet.',
        'REFUND_PENDING':'The refund has been initiated, but the payment provider has not confirmed completion. Its status needs to be checked again.',
        'REFUND_FAILED':'The payment provider could not complete the refund. Acme Refund Operations needs to review the response.',
        'DECLINED':explanation+' No refund has been issued for this request.',
        'REJECTED':'An Acme manager declined this request. No refund has been issued. Contact Acme Refund Operations if a review is needed.',
        'HELD':'Verified purchase, return or usage information is still needed. Acme Refund Operations must review that evidence before this request can continue.',
        'EXPIRED':'The 24-hour approval window expired. No refund was issued. Contact Acme Refund Operations for a new review.'}
    slack+='\n\n'+summaries[outcome]+'\n\n*Refund reference:* '+ref
    if outcome=='COMPLETED' and case.get('input',{}).get('channel')=='email':
        sent=case.get('notifications',{}).get('COMPLETED:email',{}).get('state')=='sent'
        slack+='\n'+('Customer update: sent by email.' if sent else 'Customer email: delivery needs review.')
    return {'reference':ref,'title':heading,'product':name,'amount':value,'pct':pct,'subject':subject,'email':email,'slack':slack,'body':body}

def approval(case,product=None,company=None):
    view=render(case,'AWAITING_APPROVAL',product,company);a=case['assessment'];company=company or case.get('policy_display') or {}
    original=money(a['paid_minor'],a['currency']);low=percentage(company['approval_from_pct'])+'%' if company.get('approval_from_pct') is not None else 'the approval threshold'
    high=percentage(company['max_refund_pct'])+'%' if company.get('max_refund_pct') is not None else 'the company limit'
    text=f"*Refund approval needed*\n*Product:* {view['product']}\n*Customer:* {case['input']['customerEmail']}\n*Requested refund:* {view['amount']} ({view['pct']}% of {original})\n\nPurchase and product refund conditions have been checked. Requests from {low} through {high} require a manager’s approval.\n\nPlease approve or decline within 24 hours. We will check the purchase and policy again before issuing the refund.\n\n*Refund reference:* {view['reference']}"
    return text

def resolved_card(case,outcome,product=None,company=None):
    view=render(case,outcome,product,company);decision=case.get('approval',{});actor=decision.get('actor')
    text=view['slack']
    if actor:text+='\nManager decision: '+{'approve':'Approved','reject':'Declined'}.get(decision['decision'],'Reviewed')+' by <@'+actor+'>.'
    return text

def processing_card(case):
    view=render(case,'AWAITING_APPROVAL');actor=case['approval']['actor']
    return (f"*Processing refund*\n*Product:* {view['product']}\n*Requested refund:* {view['amount']} ({view['pct']}%)"
            f"\n\nApproval received from <@{actor}>. We’re checking the purchase, current balance and product policy again before submitting the refund."
            "\nPlease wait — you don’t need to click again. This message will update with the confirmed outcome."
            f"\n\n*Refund reference:* {view['reference']}")
