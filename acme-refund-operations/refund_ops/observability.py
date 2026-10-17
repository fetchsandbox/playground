"""Explicit, redacted ADOT spans. Durable business events are saved independently."""
import atexit,os
from contextlib import contextmanager
_TRACER=None

def tracer():
    global _TRACER
    if _TRACER is not None:return _TRACER
    if os.getenv('ADOT_ENABLED')!='true':return None
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.resources import Resource
    from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter
    import botocore.session
    region=os.getenv('AWS_REGION','us-west-2')
    provider=TracerProvider(resource=Resource.create({'service.name':'acme-refund-operations','service.version':'acme-refund-1.0.3'}))
    provider.add_span_processor(BatchSpanProcessor(OTLPAwsSpanExporter(aws_region=region,session=botocore.session.Session(),endpoint=f'https://xray.{region}.amazonaws.com/v1/traces',timeout=5),schedule_delay_millis=1000))
    atexit.register(provider.shutdown);_TRACER=provider.get_tracer('acme.refund.business');return _TRACER

@contextmanager
def span(run,name):
    t=tracer()
    if not t:yield;return
    from opentelemetry import trace
    from opentelemetry.trace import SpanContext,TraceFlags,NonRecordingSpan
    parent=SpanContext(int(run['trace_id'],16),int(run['root_span_id'],16),False,TraceFlags(1))
    with t.start_as_current_span(name,context=trace.set_span_in_context(NonRecordingSpan(parent)),attributes={'workflow.run_id':run['run_id'],'workflow.case_id':run['case_id']},record_exception=False,set_status_on_exception=False):yield

def span_id(default):
    from opentelemetry import trace
    c=trace.get_current_span().get_span_context();return format(c.span_id,'016x') if c.is_valid else default
