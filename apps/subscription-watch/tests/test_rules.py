import base64
from datetime import date, datetime, timezone

from subwatch.config import DEFAULT_RULES
from subwatch.gmail import Email, parse_raw
from subwatch.rules import evaluate, extract_renewal_date, load_rules
from tests.fakes import raw_email

RULES = load_rules(DEFAULT_RULES)
TODAY = date(2026, 10, 13)


def mail(sender_name, sender, subject, body, when=datetime(2026, 10, 13, tzinfo=timezone.utc)):
    return Email("m1", sender_name, sender, subject, when, body)


def test_subscription_receipt_matches_and_extracts_details():
    m = evaluate(RULES, mail("Netflix", "info@account.netflix.com", "Your Netflix subscription payment receipt",
                             "Your monthly subscription of $15.49 was charged. Next billing date: November 13, 2026."), TODAY)
    assert m is not None
    assert m.vendor == "Netflix"
    assert m.amount == "$15.49"
    assert m.renewal_date == date(2026, 11, 13)
    assert m.reminder_date == date(2026, 11, 10)  # 3 days before renewal


def test_invoice_without_renewal_date_uses_default_offset():
    m = evaluate(RULES, mail("", "billing@notion.so", "Invoice #4821 for your Plus plan",
                             "Thanks! Your annual plan subscription total: 96.00 USD."), TODAY)
    assert m is not None
    assert m.vendor == "Notion"
    assert m.amount == "96.00 USD"
    assert m.renewal_date is None
    assert m.reminder_date == date(2026, 10, 20)


def test_renewal_already_close_reminds_tomorrow_not_in_the_past():
    m = evaluate(RULES, mail("Spotify", "no-reply@spotify.com", "Your Spotify Premium receipt",
                             "Your subscription renews on 14 October 2026."), TODAY)
    assert m.reminder_date == date(2026, 10, 14)


def test_non_subscription_mail_is_ignored():
    assert evaluate(RULES, mail("Mom", "mom@example.test", "Dinner sunday?", "Bring dessert"), TODAY) is None
    # A newsletter footer says "unsubscribe" - that must not count as "subscription".
    assert evaluate(RULES, mail("News", "news@site.test", "Weekly digest receipt of ideas",
                                "Great reads. Click to unsubscribe."), TODAY) is None


def test_excluded_phrases_win():
    assert evaluate(RULES, mail("Amazon", "ship@amazon.com", "Your payment receipt",
                                "Your subscription box order has shipped."), TODAY) is None


def test_date_formats():
    assert extract_renewal_date("next payment date: 2026-12-01") == date(2026, 12, 1)
    assert extract_renewal_date("will renew on Dec 1st, 2026") == date(2026, 12, 1)
    assert extract_renewal_date("Next charge 12/01/2026") == date(2026, 12, 1)
    assert extract_renewal_date("auto-renews on Sept. 3, 2027") == date(2027, 9, 3)
    assert extract_renewal_date("no date here") is None


def test_parse_raw_html_body_and_garbage():
    raw = raw_email("Adobe <mail@adobe.com>", "Your invoice", "<p>Your <b>subscription</b> renews on 2026-11-01</p>",
                    content_type="text/html")
    e = parse_raw("x", raw)
    assert e.sender_name == "Adobe" and e.sender_address == "mail@adobe.com"
    assert "subscription renews on 2026-11-01" in e.body
    assert parse_raw("y", "sample-value") is None
    assert parse_raw("z", "!!!not base64") is None


def test_trial_end_is_treated_as_the_charge_date():
    m = evaluate(RULES, mail("Canva", "no-reply@canva.com", "Your Canva Pro trial ends soon",
                             "Your free trial ends on 2026-11-30. After that you will be charged $119.99 per year."), TODAY)
    assert m.renewal_date == date(2026, 11, 30) and m.reminder_date == date(2026, 11, 27)


def test_day_first_numeric_date():
    assert extract_renewal_date("Next payment date: 15/11/2026") == date(2026, 11, 15)
    assert extract_renewal_date("Next payment date: 11/05/2026") == date(2026, 11, 5)  # ambiguous: month-first


def test_body_without_charset_decodes_as_utf8():
    raw = base64.urlsafe_b64encode(
        "From: G <m@theguardian.com>\r\nSubject: Your membership payment receipt\r\n"
        "Content-Type: text/plain\r\n\r\nPayment of \u00a37.99 received.\r\n".encode()).decode()
    assert "\u00a37.99" in parse_raw("x", raw).body
