"""Evidence-backed refund eligibility. Text models cannot authorize money movement."""
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone
import hashlib, json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def assess(payment, product, company, terms, order, pct, now):
    """Use merchant/provider facts, never conditions claimed in customer text."""
    reasons = []
    paid = int(payment.get('amount_received', 0))
    pct = Decimal(str(pct))
    amount = int((Decimal(paid) * pct / 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    refunded = int(payment.get('refund_committed', 0))
    age = (now - int(payment['created'])) / 86400
    evidence = [{'document_id': company['id'], 'version': company['version'], 'sha256': digest(company)},
                {'document_id': terms['id'], 'version': terms['version'], 'sha256': digest(terms)}]
    if payment.get('status') != 'succeeded' or not paid: reasons.append('payment_not_settled')
    if payment.get('disputed'): reasons.append('payment_disputed')
    if age < 0: reasons.append('purchase_date_invalid')
    if age > terms['refund_window_days']: reasons.append('outside_product_refund_window')
    if not terms['refundable']: reasons.append('product_not_refundable')
    if terms.get('requires_inspected_return'):
        if order.get('return_status') != 'received_inspected' or order.get('return_condition') != 'resalable':
            reasons.append('inspected_resalable_return_required')
    if terms.get('usage_max_pct') is not None:
        if order.get('usage_pct') is None: reasons.append('usage_evidence_missing')
        elif Decimal(str(order['usage_pct'])) > Decimal(str(terms['usage_max_pct'])): reasons.append('usage_exceeds_product_policy')
    if order.get('payment_intent') != payment['id'] or order.get('sku') != product['sku']: reasons.append('merchant_order_evidence_mismatch')
    if amount <= 0 or amount > paid - refunded: reasons.append('amount_exceeds_remaining_paid_balance')
    # Cumulative cap prevents repeated small requests bypassing the company limit.
    if paid and Decimal(refunded + amount) * 100 > Decimal(paid) * Decimal(str(company['max_refund_pct'])):
        reasons.append('company_cumulative_refund_cap_exceeded')
    if pct > Decimal(str(company['max_refund_pct'])): reasons.append('requested_percentage_above_company_cap')
    missing = {'usage_evidence_missing','inspected_resalable_return_required','merchant_order_evidence_mismatch','purchase_date_invalid'}
    decision = ('hold' if any(x in missing for x in reasons) else 'decline') if reasons else ('auto' if pct < Decimal(str(company['approval_from_pct'])) else 'approval')
    return {'decision': decision, 'eligible': not reasons, 'reasons': reasons or ['eligible_under_company_and_product_policy'],
            'amount_minor': amount, 'currency': payment['currency'], 'requested_pct': str(pct), 'paid_minor': paid,
            'already_refunded_minor': refunded, 'age_days': round(age, 3), 'sku': product['sku'], 'evidence': evidence,
            'snapshot_hash': digest({'payment_id': payment['id'], 'paid': paid, 'refunded': refunded, 'product': product,
                                     'company': company, 'terms': terms, 'order': order, 'amount': amount})}
