"""Running app + real FetchSandbox twins over loopback HTTP, not provider fakes.

Run with FETCHSANDBOX_ENGINE_ROOT pointing at the backend checkout. The baseline
switch removes only the new confirm/capture adapter declarations, exercising the
unchanged original generic action handler with the same assertions.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[1]
if not os.environ.get('FETCHSANDBOX_ENGINE_ROOT'):
    pytest.skip('Set FETCHSANDBOX_ENGINE_ROOT to run the actual-twin integration test.', allow_module_level=True)
ENGINE_ROOT = Path(os.environ['FETCHSANDBOX_ENGINE_ROOT']).resolve()
sys.path.insert(0, str(ENGINE_ROOT))
from app.sandbox.manager import SandboxManager
from app.sandbox.router import create_router

spec = importlib.util.spec_from_file_location('receipt_qa', ROOT / 'qa/twin_workflow.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def test_payment_completion_to_exactly_one_receipt(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    manager = SandboxManager(ENGINE_ROOT / 'specs', ENGINE_ROOT / 'configs', lazy=True)
    manager.load_spec_index()
    engines = {}; bindings = {}; proxies = {}; process = None; server = None; thread = None
    secret = 'whsec_loopback_completion_test'
    evidence = {'scope': 'actual uvicorn app and actual FetchSandbox engines over loopback HTTP; QA transports the twin-emitted payload',
                'baseline': os.environ.get('FETCHSANDBOX_COMPLETION_BASELINE') == '1',
                'real_payments': False, 'real_inbox_delivery': False, 'external_webhook_delivery': False}
    try:
        api = FastAPI(); api.include_router(create_router(manager))
        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(128)
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(api, log_level='error'))
        thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True); thread.start()
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline: time.sleep(.05)
        assert server.started
        for provider in ('stripe', 'resend'):
            sid = manager.resolve_spec_id(provider); manager.get_spec(sid)
            sb, engine = manager.create_sandbox(sid)
            engines[provider] = engine
            if provider == 'stripe' and evidence['baseline']:
                for operation in engine._operation_map.values():
                    if operation.get('completion_behavior') == 'stripe_payment_intent':
                        operation.clear()
                engine._operation_map = {k: v for k, v in engine._operation_map.items() if v}
            bindings[provider] = {'base_url': f'http://127.0.0.1:{port}/sandbox/{sb.id}',
                                  'api_key': engine.auth.get_credentials()[0]['api_key']}
            proxies[provider] = qa.ProviderProxy(provider, bindings[provider], None); proxies[provider].start()
        env = os.environ.copy(); env.update(STRIPE_API_KEY=bindings['stripe']['api_key'],
            STRIPE_API_BASE=proxies['stripe'].base_url, STRIPE_WEBHOOK_SECRET=secret,
            RESEND_API_KEY=bindings['resend']['api_key'], RESEND_API_BASE=proxies['resend'].base_url,
            RESEND_FROM='receipts@example.test')
        app_port = qa.free_port()
        process = subprocess.Popen([str(ROOT / '.venv/bin/python'), '-m', 'uvicorn', 'main:app',
            '--host', '127.0.0.1', '--port', str(app_port), '--log-level', 'error'], cwd=ROOT,
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with httpx.Client(base_url=f'http://127.0.0.1:{app_port}', timeout=30, trust_env=False) as client:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    if client.get('/openapi.json').status_code == 200: break
                except httpx.TransportError: pass
                assert process.poll() is None, 'App startup failed'
                time.sleep(.05)
            flow = qa.Workflow(client, secret, 3, .1)
            before = engines['resend'].state.collection('emails').count()
            order, payment = flow.new_order('completion')
            with httpx.Client(base_url=proxies['stripe'].base_url, trust_env=False, timeout=30,
                    headers={'Authorization': 'Bearer ' + bindings['stripe']['api_key']}) as stripe_client:
                confirmed = stripe_client.post(f"/v1/payment_intents/{payment['payment_intent_id']}/confirm", data={'payment_method': 'pm_card_visa'})
                evidence['confirm_http'] = confirmed.status_code
                evidence['confirmed_state'] = confirmed.json().get('status')
                evidence['amount_received'] = confirmed.json().get('amount_received')
                assert confirmed.status_code == 200
                assert confirmed.json()['status'] == 'succeeded'
                assert confirmed.json()['amount_received'] == order['amount_cents']
                stored = stripe_client.get(f"/v1/payment_intents/{payment['payment_intent_id']}").json()
                assert stored == confirmed.json()
            event = next(e for e in engines['stripe'].get_webhook_events(100)
                         if e.event_type == 'payment_intent.succeeded' and e.payload['id'] == payment['payment_intent_id'])
            assert event.payload == stored
            envelope = {'id': 'evt_' + event.id, 'object': 'event', 'type': event.event_type,
                        'created': int(time.time()), 'livemode': False, 'data': {'object': event.payload}}
            assert flow.deliver('provider_emitted_success', envelope)['status'] == 200
            flow.paid_once(order, 'after_success')
            receipt = flow.inspect(order, 'receipt')['receipt_ids'][0]
            assert engines['resend'].state.collection('emails').count() == before + 1
            assert engines['resend'].state.collection('emails').get(receipt) is not None
            assert flow.deliver('redelivered_same_event', envelope)['status'] == 200
            flow.paid_once(order, 'after_duplicate')
            assert engines['resend'].state.collection('emails').count() == before + 1
            assert all(c['passed'] for c in flow.checks)
            evidence.update(result='passed', email_count_before=before, email_count_after=before+1,
                            event_source='actual Stripe twin event payload; no invented amount/status',
                            checks=flow.checks)
    except BaseException as exc:
        evidence.update(result='failed', error=type(exc).__name__)
        raise
    finally:
        if process:
            process.terminate(); process.wait(timeout=10)
        for proxy in proxies.values(): proxy.close()
        if server: server.should_exit = True
        if thread: thread.join(timeout=10)
        evidence['provider_calls'] = {name: proxy.calls for name, proxy in proxies.items()}
        evidence['cleanup'] = {'app_stopped': process is None or process.poll() is not None,
                               'twin_server_stopped': thread is None or not thread.is_alive()}
        output = os.environ.get('FETCHSANDBOX_COMPLETION_EVIDENCE')
        if output:
            sensitive = [secret] + [b['api_key'] for b in bindings.values()]
            Path(output).write_text(json.dumps(qa.sanitize(evidence, sensitive), indent=2) + '\n')
