"""Workflow persistence with conditional writes for race safety.

Local mode uses an in-process lock + dict. AWS mode uses DynamoDB
conditional PutItem / UpdateItem (wired via env CUSTOMER_OPS_TABLE).
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Protocol

from customer_ops.models import WorkflowRecord, WorkflowStatus, utcnow


class ClaimConflict(Exception):
    """Another worker already owns this idempotency key / open lease."""

    def __init__(self, existing: WorkflowRecord):
        self.existing = existing
        super().__init__(f"claim conflict for {existing.idempotency_key}")


class WorkflowStore(Protocol):
    def get_by_idempotency(self, key: str) -> WorkflowRecord | None: ...

    def get(self, workflow_id: str) -> WorkflowRecord | None: ...

    def claim(
        self,
        record: WorkflowRecord,
        *,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> WorkflowRecord: ...

    def save(self, record: WorkflowRecord, *, expected_updated_at: datetime | None = None) -> WorkflowRecord: ...

    def list_recent(self, limit: int = 50) -> list[WorkflowRecord]: ...


class InMemoryWorkflowStore:
    """Thread-safe store used by local FastAPI and unit tests."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._by_id: dict[str, WorkflowRecord] = {}
        self._by_idem: dict[str, str] = {}

    def get_by_idempotency(self, key: str) -> WorkflowRecord | None:
        with self._lock:
            wid = self._by_idem.get(key)
            return self._by_id.get(wid) if wid else None

    def get(self, workflow_id: str) -> WorkflowRecord | None:
        with self._lock:
            rec = self._by_id.get(workflow_id)
            return rec.model_copy(deep=True) if rec else None

    def claim(
        self,
        record: WorkflowRecord,
        *,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> WorkflowRecord:
        with self._lock:
            existing_id = self._by_idem.get(record.idempotency_key)
            if existing_id:
                existing = self._by_id[existing_id]
                # Duplicate Slack delivery / concurrent HTTP post
                if existing.status not in {WorkflowStatus.FAILED}:
                    raise ClaimConflict(existing.model_copy(deep=True))
                # Failed workflows may be retried under same key after lease expiry
                if existing.lease_until and existing.lease_until > utcnow():
                    raise ClaimConflict(existing.model_copy(deep=True))

            record.lease_owner = lease_owner
            record.lease_until = utcnow() + timedelta(seconds=lease_seconds)
            record.status = WorkflowStatus.CLAIMED
            record.touch()
            stored = record.model_copy(deep=True)
            self._by_id[stored.workflow_id] = stored
            self._by_idem[stored.idempotency_key] = stored.workflow_id
            return stored.model_copy(deep=True)

    def save(
        self,
        record: WorkflowRecord,
        *,
        expected_updated_at: datetime | None = None,
    ) -> WorkflowRecord:
        with self._lock:
            current = self._by_id.get(record.workflow_id)
            if current is None:
                raise KeyError(record.workflow_id)
            if expected_updated_at is not None and current.updated_at != expected_updated_at:
                raise ClaimConflict(current.model_copy(deep=True))
            record.touch()
            stored = record.model_copy(deep=True)
            self._by_id[stored.workflow_id] = stored
            self._by_idem[stored.idempotency_key] = stored.workflow_id
            return stored.model_copy(deep=True)

    def list_recent(self, limit: int = 50) -> list[WorkflowRecord]:
        with self._lock:
            items = sorted(self._by_id.values(), key=lambda r: r.created_at, reverse=True)
            return [r.model_copy(deep=True) for r in items[:limit]]


class DynamoWorkflowStore:
    """DynamoDB-backed store. Table PK=pk SK=sk; GSI on idempotency_key."""

    def __init__(self, table_name: str | None = None):
        import boto3

        self.table_name = table_name or os.environ["CUSTOMER_OPS_TABLE"]
        self._ddb = boto3.resource("dynamodb")
        self._table = self._ddb.Table(self.table_name)

    def _serialize(self, record: WorkflowRecord) -> dict:
        payload = json.loads(record.model_dump_json())
        return {
            "pk": f"wf#{record.workflow_id}",
            "sk": "meta",
            "idempotency_key": record.idempotency_key,
            "gsi1pk": f"idem#{record.idempotency_key}",
            "gsi1sk": "meta",
            "payload": payload,
            "updated_at": record.updated_at.isoformat(),
        }

    def _deserialize(self, item: dict) -> WorkflowRecord:
        return WorkflowRecord.model_validate(item["payload"])

    def get(self, workflow_id: str) -> WorkflowRecord | None:
        resp = self._table.get_item(Key={"pk": f"wf#{workflow_id}", "sk": "meta"})
        item = resp.get("Item")
        return self._deserialize(item) if item else None

    def get_by_idempotency(self, key: str) -> WorkflowRecord | None:
        resp = self._table.query(
            IndexName="gsi1",
            KeyConditionExpression="gsi1pk = :pk AND gsi1sk = :sk",
            ExpressionAttributeValues={":pk": f"idem#{key}", ":sk": "meta"},
            Limit=1,
        )
        items = resp.get("Items") or []
        return self._deserialize(items[0]) if items else None

    def claim(
        self,
        record: WorkflowRecord,
        *,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> WorkflowRecord:
        existing = self.get_by_idempotency(record.idempotency_key)
        if existing and existing.status not in {WorkflowStatus.FAILED}:
            raise ClaimConflict(existing)

        record.lease_owner = lease_owner
        record.lease_until = utcnow() + timedelta(seconds=lease_seconds)
        record.status = WorkflowStatus.CLAIMED
        record.touch()
        item = self._serialize(record)
        try:
            self._table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(gsi1pk) OR #s = :failed",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":failed": WorkflowStatus.FAILED.value},
            )
        except self._ddb.meta.client.exceptions.ConditionalCheckFailedException:
            again = self.get_by_idempotency(record.idempotency_key)
            if again:
                raise ClaimConflict(again) from None
            raise
        # Also write status attribute at top level for conditions
        self._table.update_item(
            Key={"pk": item["pk"], "sk": "meta"},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": record.status.value},
        )
        return record

    def save(
        self,
        record: WorkflowRecord,
        *,
        expected_updated_at: datetime | None = None,
    ) -> WorkflowRecord:
        record.touch()
        item = self._serialize(record)
        if expected_updated_at is None:
            self._table.put_item(Item={**item, "status": record.status.value})
            return record
        try:
            self._table.put_item(
                Item={**item, "status": record.status.value},
                ConditionExpression="updated_at = :u",
                ExpressionAttributeValues={":u": expected_updated_at.isoformat()},
            )
        except self._ddb.meta.client.exceptions.ConditionalCheckFailedException:
            current = self.get(record.workflow_id)
            if current:
                raise ClaimConflict(current) from None
            raise
        return record

    def list_recent(self, limit: int = 50) -> list[WorkflowRecord]:
        # Scan is fine for demo scale; production should use a time GSI.
        resp = self._table.scan(Limit=limit)
        records = [self._deserialize(i) for i in resp.get("Items", []) if "payload" in i]
        return sorted(records, key=lambda r: r.created_at, reverse=True)[:limit]


_STORE: WorkflowStore | None = None


def get_store() -> WorkflowStore:
    global _STORE
    if _STORE is None:
        if os.environ.get("CUSTOMER_OPS_TABLE"):
            _STORE = DynamoWorkflowStore()
        else:
            _STORE = InMemoryWorkflowStore()
    return _STORE


def reset_store_for_tests(store: WorkflowStore | None = None) -> WorkflowStore:
    global _STORE
    _STORE = store or InMemoryWorkflowStore()
    return _STORE
