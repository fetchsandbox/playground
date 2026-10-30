CREATE ROLE app LOGIN PASSWORD :'app_password';
CREATE ROLE sink LOGIN PASSWORD :'sink_password';
CREATE DATABASE app OWNER app;
CREATE DATABASE sink OWNER sink;
\connect app
SET ROLE app;
CREATE TABLE bindings(shopper_id text NOT NULL,provider_user_id text NOT NULL,thread_id text NOT NULL,PRIMARY KEY(shopper_id,thread_id));
INSERT INTO bindings VALUES('shopper-a','provider-a','thread-a'),('shopper-b','provider-b','thread-b'),('shopper-a','provider-a','thread-a2');
CREATE TABLE inbox(scope text,event_id text,payload_hash text NOT NULL,PRIMARY KEY(scope,event_id));
CREATE TABLE outbox(scope text,event_id text,payload jsonb NOT NULL,delivered_at timestamptz,PRIMARY KEY(scope,event_id));
CREATE TABLE rejections(event_id text,reason text);
\connect sink
SET ROLE sink;
CREATE TABLE messages(idempotency_key text PRIMARY KEY,payload_hash text NOT NULL,event_id text,shopper_id text,thread_id text,text text);
CREATE TABLE attempts(event_id text);
CREATE TABLE controls(event_id text PRIMARY KEY,action text);
