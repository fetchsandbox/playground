import contextlib,time,secrets
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from .core import ShopError
class Store:
 def __init__(self,table):self.t=table
 def get(self,key):return self.t.get_item(Key={'pk':key},ConsistentRead=True).get('Item')
 def put(self,r):self.t.put_item(Item=r)
 def delete(self,key):self.t.delete_item(Key={'pk':key})
 def create(self,r):
  try:self.t.put_item(Item=r,ConditionExpression='attribute_not_exists(pk)')
  except ClientError as e:
   if e.response['Error']['Code']!='ConditionalCheckFailedException':raise
 def save(self,r):
  self.t.put_item(Item=r,ConditionExpression='lease_owner = :owner',ExpressionAttributeValues={':owner':r['lease_owner']})
 def increment(self,key,ttl,field='count'):
  return int(self.t.update_item(Key={'pk':key},UpdateExpression='SET #n = if_not_exists(#n, :zero) + :one, #ttl = :ttl',ExpressionAttributeNames={'#n':field,'#ttl':'ttl'},ExpressionAttributeValues={':zero':0,':one':1,':ttl':ttl},ReturnValues='UPDATED_NEW')['Attributes'][field])
 def consume(self,key):
  try:self.t.update_item(Key={'pk':key},UpdateExpression='SET used = :yes',ConditionExpression='attribute_not_exists(used)',ExpressionAttributeValues={':yes':True});return True
  except ClientError as e:
   if e.response['Error']['Code']=='ConditionalCheckFailedException':return False
   raise
 @contextlib.contextmanager
 def lease(self,key):
  owner=secrets.token_hex(16)
  try:self.t.update_item(Key={'pk':key},UpdateExpression='SET lease_owner=:o,lease_until=:until',ConditionExpression='attribute_exists(pk) AND (attribute_not_exists(lease_until) OR lease_until < :now)',ExpressionAttributeValues={':o':owner,':until':int(time.time())+175,':now':int(time.time())})
  except ClientError as e:
   if e.response['Error']['Code']=='ConditionalCheckFailedException':raise ShopError('This order is being updated. Please retry shortly.',409)
   raise
  try:yield self.get(key)
  finally:
   try:self.t.update_item(Key={'pk':key},UpdateExpression='REMOVE lease_owner,lease_until',ConditionExpression='lease_owner=:o',ExpressionAttributeValues={':o':owner})
   except ClientError:pass
 def orders(self,owner):return self.t.query(IndexName='owner-created',KeyConditionExpression=Key('owner').eq(owner),ScanIndexForward=False,Limit=30)['Items']
 def due(self,now):return self.t.query(IndexName='sync-due',KeyConditionExpression=Key('syncpk').eq('SYNC') & Key('due').lte(now),Limit=20)['Items']
 def patch_due(self,r):self.t.update_item(Key={'pk':r['pk']},UpdateExpression='SET due=:n',ExpressionAttributeValues={':n':r['due']})
