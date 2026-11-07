/** One input boundary shared by the adapter and embedded native n8n source. */
export function parseLeadInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.prototype.hasOwnProperty.call(value, 'lead_id')
      || typeof value.lead_id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.lead_id)
      || Object.keys(value).some(key => !['lead_id', 'retry_failed'].includes(key))
      || ('retry_failed' in value && typeof value.retry_failed !== 'boolean')) return null;
  return {lead_id:value.lead_id, retry_failed:value.retry_failed === true};
}
