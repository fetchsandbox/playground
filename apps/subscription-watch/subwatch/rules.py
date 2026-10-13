"""Decide whether an email is a subscription charge, and pull out the details.

Rules live in rules.json so they can change without a deploy. A rule matches
when every condition it declares holds:

  from_domains_any  sender address ends with one of these domains
  subject_any       subject contains one of these phrases
  text_any          subject or body contains one of these phrases
  exclude_any       neither subject nor body contains any of these phrases

Phrases match case-insensitively on word boundaries.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .gmail import Email

_MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"
_DATE_TEXT = (
    rf"(?:(?:{_MONTHS})[a-z]*\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"  # November 13, 2026
    rf"|\d{{1,2}}(?:st|nd|rd|th)?\s+(?:{_MONTHS})[a-z]*\.?,?\s+\d{{4}}"  # 13 November 2026
    r"|\d{4}-\d{2}-\d{2}"  # 2026-11-13
    r"|\d{1,2}/\d{1,2}/\d{4})"  # 11/13/2026 (US order)
)
_RENEWAL = re.compile(
    r"(?:next\s+(?:billing|payment|charge|renewal|invoice)(?:\s+date)?"
    r"|renewal\s+date|renews\s+on|will\s+renew\s+on|will\s+be\s+(?:charged|billed|renewed)\s+on"
    r"|auto[- ]renews?\s+on)"
    rf"\D{{0,20}}?({_DATE_TEXT})",
    re.IGNORECASE,
)
_AMOUNT = re.compile(r"(?:[$€£₹]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|INR)\b)")
_SENDER_NOISE = re.compile(r"\b(billing|team|support|no-?reply|notifications?|payments?|accounts?|receipts?|inc\.?|llc)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Rule:
    name: str
    from_domains_any: tuple[str, ...] = ()
    subject_any: tuple[str, ...] = ()
    text_any: tuple[str, ...] = ()
    exclude_any: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuleSet:
    rules: tuple[Rule, ...]
    reminder_days_before_renewal: int = 3
    default_reminder_days: int = 7


@dataclass(frozen=True)
class Match:
    rule: str
    vendor: str
    amount: str | None
    renewal_date: date | None
    reminder_date: date


def load_rules(path: Path) -> RuleSet:
    raw = json.loads(Path(path).read_text())
    rules = tuple(
        Rule(
            name=r["name"],
            from_domains_any=tuple(d.lower().lstrip("@") for d in r.get("from_domains_any", [])),
            subject_any=tuple(r.get("subject_any", [])),
            text_any=tuple(r.get("text_any", [])),
            exclude_any=tuple(r.get("exclude_any", [])),
        )
        for r in raw["rules"]
    )
    if not rules:
        raise ValueError("rules.json declares no rules")
    return RuleSet(
        rules=rules,
        reminder_days_before_renewal=int(raw.get("reminder_days_before_renewal", 3)),
        default_reminder_days=int(raw.get("default_reminder_days", 7)),
    )


def _has_any(text: str, phrases: tuple[str, ...]) -> bool:
    return any(re.search(rf"(?<!\w){re.escape(p)}(?!\w)", text, re.IGNORECASE) for p in phrases)


def _rule_matches(rule: Rule, msg: Email) -> bool:
    text = f"{msg.subject}\n{msg.body}"
    if rule.from_domains_any and not any(
        msg.sender_address.endswith("@" + d) or msg.sender_address.endswith("." + d) for d in rule.from_domains_any
    ):
        return False
    if rule.subject_any and not _has_any(msg.subject, rule.subject_any):
        return False
    if rule.text_any and not _has_any(text, rule.text_any):
        return False
    if rule.exclude_any and _has_any(text, rule.exclude_any):
        return False
    return True


def evaluate(ruleset: RuleSet, msg: Email, today: date | None = None) -> Match | None:
    rule = next((r for r in ruleset.rules if _rule_matches(r, msg)), None)
    if rule is None:
        return None
    text = f"{msg.subject}\n{msg.body}"
    today = today or datetime.now(timezone.utc).date()
    renewal = extract_renewal_date(text)
    if renewal is not None:
        reminder = renewal - timedelta(days=ruleset.reminder_days_before_renewal)
    else:
        received = msg.date.date() if msg.date else today
        reminder = received + timedelta(days=ruleset.default_reminder_days)
    # Never schedule the reminder in the past: if the renewal is close, remind tomorrow.
    reminder = max(reminder, today + timedelta(days=1))
    amount = _AMOUNT.search(text)
    return Match(
        rule=rule.name,
        vendor=vendor_name(msg),
        amount=amount.group(0).strip() if amount else None,
        renewal_date=renewal,
        reminder_date=reminder,
    )


def extract_renewal_date(text: str) -> date | None:
    m = _RENEWAL.search(text)
    return _parse_date(m.group(1)) if m else None


def _parse_date(s: str) -> date | None:
    s = re.sub(r"(\d)(st|nd|rd|th)", r"\1", s.strip(), flags=re.IGNORECASE).replace(",", "").replace(".", "")
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\bSept\b", "Sep", s, flags=re.IGNORECASE)
    for fmt in ("%B %d %Y", "%b %d %Y", "%d %B %Y", "%d %b %Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def vendor_name(msg: Email) -> str:
    name = _SENDER_NOISE.sub("", msg.sender_name or "").strip(" -|,")
    if name:
        return name
    domain = msg.sender_address.rsplit("@", 1)[-1]
    labels = domain.split(".")[:-1]  # drop the TLD
    if len(labels) > 1 and labels[-1] in {"co", "com", "org", "net", "ac", "gov"}:
        labels = labels[:-1]  # second-level suffix such as .co.uk
    return (labels[-1] if labels else domain).capitalize()
