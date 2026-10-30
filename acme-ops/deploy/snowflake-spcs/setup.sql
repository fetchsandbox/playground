-- Snowflake Snowpark Container Services: run one acme-ops workflow.
-- Replace every <...>. Requires a role with CREATE COMPUTE POOL, CREATE INTEGRATION
-- and CREATE SERVICE. Build the image for linux/amd64.

USE ROLE <role>;
USE DATABASE <db>;
USE SCHEMA <schema>;

CREATE IMAGE REPOSITORY IF NOT EXISTS acme_ops_images;
CREATE STAGE IF NOT EXISTS acme_ops_specs;
CREATE STAGE IF NOT EXISTS acme_ops_policies;
-- PUT file://deploy/snowflake-spcs/spec.yaml @acme_ops_specs/<workflow>/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://my-policies/<workflow>.json @acme_ops_policies AUTO_COMPRESS=FALSE OVERWRITE=TRUE;

-- Egress: only the provider hosts this workflow's guide lists.
CREATE OR REPLACE NETWORK RULE acme_ops_<workflow>_egress
  MODE = EGRESS TYPE = HOST_PORT
  VALUE_LIST = ('na1.docusign.net:443', 'api.box.com:443', 'upload.box.com:443', 'dl.boxcloud.com:443',
                'api.dropboxapi.com:443', 'content.dropboxapi.com:443', 'slack.com:443');

CREATE SECRET IF NOT EXISTS acme_docusign_token TYPE = GENERIC_STRING SECRET_STRING = '<set me>';
CREATE SECRET IF NOT EXISTS acme_docusign_account TYPE = GENERIC_STRING SECRET_STRING = '<set me>';

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION acme_ops_<workflow>_access
  ALLOWED_NETWORK_RULES = (acme_ops_<workflow>_egress)
  ALLOWED_AUTHENTICATION_SECRETS = (acme_docusign_token, acme_docusign_account)
  ENABLED = TRUE;

CREATE COMPUTE POOL IF NOT EXISTS acme_ops_pool
  MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = CPU_X64_XS;

CREATE SERVICE IF NOT EXISTS acme_<workflow>
  IN COMPUTE POOL acme_ops_pool
  FROM @acme_ops_specs/<workflow>/ SPECIFICATION_FILE = 'spec.yaml'
  EXTERNAL_ACCESS_INTEGRATIONS = (acme_ops_<workflow>_access)
  MIN_INSTANCES = 1 MAX_INSTANCES = 1;

-- Call the runtime from SQL. Service functions send row batches; the runtime answers them on
-- /snowflake/invocations, one command per row, each reply as {status, body}.
CREATE OR REPLACE FUNCTION acme_<workflow>_invoke(body VARIANT)
  RETURNS VARIANT
  SERVICE = acme_<workflow>
  ENDPOINT = invocations
  AS '/snowflake/invocations';

-- SELECT SYSTEM$GET_SERVICE_STATUS('acme_<workflow>');
-- SELECT acme_<workflow>_invoke(PARSE_JSON('{"action":"describe"}'));
