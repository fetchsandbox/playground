"""DynamoDB persistent cases and payment serialization; no runtime-local production state."""
import copy, threading, time
from decimal import Decimal

class Busy(RuntimeError): pass

class MemoryStore:
    def __init__(self): self.data = {}; self.mutex = threading.RLock()
    def get(self, key):
        with self.mutex: return copy.deepcopy(self.data.get(key))
    def create(self, key, value):
        with self.mutex:
            if key in self.data: return False
            self.data[key] = copy.deepcopy(value); return True
    def lock(self, key, owner, seconds=180):
        with self.mutex:
            row = self.data.setdefault(key, {})
            if row.get('lease_until', 0) > time.time(): raise Busy('Case or payment is being processed')
            row.update(lease_owner=owner, lease_until=int(time.time())+seconds)
    def save(self, key, value, owner):
        with self.mutex:
            row = self.data[key]
            if row.get('lease_owner') != owner or row.get('lease_until', 0) <= time.time(): raise Busy('Lease lost; execution held')
            self.data[key] = {**copy.deepcopy(value), 'lease_owner':owner, 'lease_until':row['lease_until']}
    def unlock(self, key, owner):
        with self.mutex:
            if self.data.get(key, {}).get('lease_owner') == owner: self.data[key]['lease_until'] = 0

class DynamoStore:
    def __init__(self, table):
        import boto3
        self.table = boto3.resource('dynamodb').Table(table)
    def get(self, key): return self.table.get_item(Key={'pk':key},ConsistentRead=True).get('Item')
    def create(self, key, value):
        try:
            self.table.put_item(Item=encode({**value,'pk':key}),ConditionExpression='attribute_not_exists(pk)'); return True
        except self.table.meta.client.exceptions.ConditionalCheckFailedException: return False
    def lock(self, key, owner, seconds=180):
        try:
            self.table.update_item(Key={'pk':key},UpdateExpression='SET lease_owner=:o, lease_until=:u',
                ConditionExpression='attribute_not_exists(lease_until) OR lease_until <= :n',
                ExpressionAttributeValues={':o':owner,':u':int(time.time())+seconds,':n':int(time.time())})
        except self.table.meta.client.exceptions.ConditionalCheckFailedException: raise Busy('Case or payment is being processed')
    def save(self, key, value, owner):
        row=self.get(key)
        if not row: raise Busy('Lease missing')
        try:
            self.table.put_item(Item=encode({**value,'pk':key,'lease_owner':owner,'lease_until':row['lease_until']}),
                ConditionExpression='lease_owner=:o AND lease_until > :n',ExpressionAttributeValues={':o':owner,':n':int(time.time())})
        except self.table.meta.client.exceptions.ConditionalCheckFailedException: raise Busy('Lease lost; execution held')
    def unlock(self, key, owner):
        try:self.table.update_item(Key={'pk':key},UpdateExpression='SET lease_until=:z',ConditionExpression='lease_owner=:o',ExpressionAttributeValues={':z':0,':o':owner})
        except self.table.meta.client.exceptions.ConditionalCheckFailedException: pass

def encode(value):
    if isinstance(value,float):return Decimal(str(value))
    if isinstance(value,dict):return {k:encode(v) for k,v in value.items()}
    if isinstance(value,list):return [encode(x) for x in value]
    return value
