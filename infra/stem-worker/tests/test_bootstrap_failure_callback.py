import base64
import contextlib
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock
from urllib import error


STACK_DIR = Path(__file__).resolve().parents[1]
TEMPLATE_PATH = STACK_DIR / "template.yaml"

CALLBACK_URL = (
    "https://abcdefghijklmnopqrst.supabase.co/functions/v1/stem-worker-callback"
)
QUEUE_ARN = "arn:aws:batch:us-east-1:123456789012:job-queue/opusloops"
JOB_DEFINITION_ARNS = {
    "inspect": "arn:aws:batch:us-east-1:123456789012:job-definition/inspect:1",
    "analyze": "arn:aws:batch:us-east-1:123456789012:job-definition/analyze:1",
    "propose": "arn:aws:batch:us-east-1:123456789012:job-definition/propose:1",
    "render": "arn:aws:batch:us-east-1:123456789012:job-definition/render:1",
}
CALLBACK_TOKEN = "a" * 64
MAINTENANCE_SECRET = "retention-test-secret-that-is-at-least-32-bytes"
JOB_ID = "01957e6f-0c75-4c52-b79a-ca4602ebd44a"
ATTEMPT_ID = "6cff198f-d767-4d8a-b173-3b00e1a32f95"
USER_ID = "bb75fb9d-9ed7-4f8c-9dc2-b6c1931aab82"
PROJECT_ID = "31e78e61-bd47-42e9-b3b0-50f512560a60"
AWS_JOB_ID = "d66dcc95-5c6a-4d52-92ba-f10b1c4e59da"
ANON_CREDENTIAL = "eyJhbGciOiJIUzI1NiJ9.test-anon.signature"
USER_SESSION = "eyJhbGciOiJIUzI1NiJ9.test-user-session.signature"


def _inline_lambda_source(resource="BootstrapFailureLambda"):
    lines = TEMPLATE_PATH.read_text(encoding="utf-8").splitlines()
    marker = "        ZipFile: |"
    resource_start = lines.index(f"  {resource}:")
    start = lines.index(marker, resource_start) + 1
    source_lines = []
    for line in lines[start:]:
        if line.startswith("          "):
            source_lines.append(line[10:])
        elif not line:
            source_lines.append("")
        else:
            break
    source = "\n".join(source_lines) + "\n"
    if "def handler(event, context):" not in source:
        raise AssertionError("bootstrap Lambda source was not found")
    return source


class _FakeSecretsManager:
    def __init__(self):
        self.calls = []

    def get_secret_value(self, **kwargs):
        self.calls.append(kwargs)
        return {"SecretString": MAINTENANCE_SECRET}


class _FakeBatch:
    def __init__(self, job):
        self.job = job
        self.describe_calls = []
        self.terminate_calls = []

    def describe_jobs(self, **kwargs):
        self.describe_calls.append(kwargs)
        return {"jobs": [self.job]}

    def terminate_job(self, **kwargs):
        self.terminate_calls.append(kwargs)
        return {}


class _Response:
    def __init__(self, body=b'{"accepted":true,"duplicate":false}'):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self, size=-1):
        return self.body[:size]


def _load_lambda():
    environment = {
        "OPUSLOOPS_CALLBACK_URL": CALLBACK_URL,
        "OPUSLOOPS_JOB_QUEUE_ARN": QUEUE_ARN,
        "OPUSLOOPS_INSPECT_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["inspect"],
        "OPUSLOOPS_ANALYZE_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["analyze"],
        "OPUSLOOPS_PROPOSE_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["propose"],
        "OPUSLOOPS_RENDER_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["render"],
    }
    module = types.ModuleType("bootstrap_failure_lambda")
    with mock.patch.dict(os.environ, environment):
        exec(
            compile(_inline_lambda_source(), str(TEMPLATE_PATH), "exec"),
            module.__dict__,
        )
    return module


def _load_queue_watchdog(batch):
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda service: batch if service == "batch" else None
    environment = {
        "OPUSLOOPS_WATCHDOG_QUEUE_ARN": (
            "arn:aws:sqs:us-east-1:123456789012:opusloops-watchdog"
        ),
        "OPUSLOOPS_JOB_QUEUE_ARN": QUEUE_ARN,
        "OPUSLOOPS_INSPECT_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["inspect"],
        "OPUSLOOPS_ANALYZE_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["analyze"],
        "OPUSLOOPS_PROPOSE_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["propose"],
        "OPUSLOOPS_RENDER_JOB_DEFINITION_ARN": JOB_DEFINITION_ARNS["render"],
    }
    module = types.ModuleType("queue_watchdog_lambda")
    with (
        mock.patch.dict(os.environ, environment),
        mock.patch.dict(sys.modules, {"boto3": boto3}),
    ):
        source = _inline_lambda_source("QueueWatchdogLambda")
        exec(compile(source, str(TEMPLATE_PATH), "exec"), module.__dict__)
    return module


def _load_retention_lambda():
    secrets = _FakeSecretsManager()
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda service: secrets if service == "secretsmanager" else None
    environment = {
        "OPUSLOOPS_RETENTION_URL": (
            "https://abcdefghijklmnopqrst.supabase.co/functions/v1/stem-retention"
        ),
        "OPUSLOOPS_RETENTION_SECRET_ARN": (
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:retention"
        ),
    }
    module = types.ModuleType("retention_invoker_lambda")
    with (
        mock.patch.dict(os.environ, environment),
        mock.patch.dict(sys.modules, {"boto3": boto3}),
    ):
        source = _inline_lambda_source("RetentionInvokerLambda")
        exec(compile(source, str(TEMPLATE_PATH), "exec"), module.__dict__)
    return module, secrets


def _payload(stage="inspect"):
    return {
        "version": 1,
        "jobId": JOB_ID,
        "userId": USER_ID,
        "projectId": PROJECT_ID,
        "attemptId": ATTEMPT_ID,
        "stage": stage,
        "revision": 3,
        "storage": {
            "endpoint": "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
            "region": "us-east-1",
            "uploadBucket": "uploads",
            "sourceBucket": "sources",
            "artifactBucket": "artifacts",
            "sourceKey": f"{USER_ID}/{PROJECT_ID}/{JOB_ID}/upload/stems.zip",
            "runPrefix": f"{USER_ID}/{PROJECT_ID}/{JOB_ID}",
            "accessKeyId": "abcdefghijklmnopqrst",
            "secretAccessKey": ANON_CREDENTIAL,
            "sessionToken": USER_SESSION,
        },
        "inputs": {"sourceSha256": None},
        "callback": {"url": CALLBACK_URL, "token": CALLBACK_TOKEN},
    }


def _event(payload=None, stage="inspect"):
    payload = _payload(stage) if payload is None else payload
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return {
        "source": "aws.batch",
        "detail-type": "Batch Job State Change",
        "detail": {
            "status": "FAILED",
            "jobId": AWS_JOB_ID,
            "jobName": f"opusloops-{stage}-{JOB_ID[:8]}-{ATTEMPT_ID[:8]}",
            "jobQueue": QUEUE_ARN,
            "jobDefinition": JOB_DEFINITION_ARNS[stage],
            "parameters": {"payload_base64": encoded},
            "statusReason": USER_SESSION,
        },
    }


def _queue_message(created_at, status="RUNNABLE"):
    job = {
        "jobId": AWS_JOB_ID,
        "jobName": f"opusloops-inspect-{JOB_ID[:8]}-{ATTEMPT_ID[:8]}",
        "jobQueue": QUEUE_ARN,
        "jobDefinition": JOB_DEFINITION_ARNS["inspect"],
        "createdAt": created_at,
        "status": status,
        "parameters": {"payload_base64": USER_SESSION},
        "statusReason": USER_SESSION,
    }
    message = {
        field: job[field]
        for field in ("createdAt", "jobDefinition", "jobId", "jobName", "jobQueue")
    }
    event = {
        "Records": [
            {
                "eventSource": "aws:sqs",
                "eventSourceARN": (
                    "arn:aws:sqs:us-east-1:123456789012:opusloops-watchdog"
                ),
                "body": json.dumps(message, separators=(",", ":")),
            }
        ]
    }
    return job, event


class BootstrapFailureCallbackTests(unittest.TestCase):
    def test_embedded_lambda_signs_contract_without_leaking_storage_auth(self):
        module = _load_lambda()
        requests = []

        def urlopen(signed_request, timeout):
            requests.append((signed_request, timeout))
            return _Response()

        module.request.urlopen = urlopen
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = module.handler(_event(), None)

        self.assertEqual(result, {"status": "reported"})
        self.assertEqual(len(requests), 1)
        signed_request, timeout = requests[0]
        self.assertEqual(timeout, 8)
        self.assertEqual(signed_request.full_url, CALLBACK_URL)
        body = signed_request.data
        callback = json.loads(body)
        self.assertEqual(callback["jobId"], JOB_ID)
        self.assertEqual(callback["attemptId"], ATTEMPT_ID)
        self.assertEqual(callback["dispatchJobId"], AWS_JOB_ID)
        self.assertEqual(callback["stage"], "inspect")
        self.assertEqual(callback["event"]["status"], "failed")
        self.assertEqual(callback["error"]["code"], "batch_bootstrap_failed")

        body_text = body.decode("utf-8")
        logs = output.getvalue()
        for sensitive in (
            ANON_CREDENTIAL,
            USER_SESSION,
            CALLBACK_TOKEN,
            "payload_base64",
        ):
            self.assertNotIn(sensitive, body_text)
            self.assertNotIn(sensitive, logs)

        headers = {key.lower(): value for key, value in signed_request.header_items()}
        timestamp = headers["x-opusloops-timestamp"]
        nonce = headers["x-opusloops-nonce"]
        expected = hmac.new(
            CALLBACK_TOKEN.encode("ascii"),
            f"{timestamp}.{nonce}.".encode("ascii") + body,
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(headers["x-opusloops-signature"], expected)
        self.assertEqual(headers["x-opusloops-job-id"], JOB_ID)
        self.assertEqual(headers["x-opusloops-attempt"], ATTEMPT_ID)

    def test_http_409_is_an_already_settled_success(self):
        module = _load_lambda()

        def conflict(signed_request, timeout):
            raise error.HTTPError(signed_request.full_url, 409, "Conflict", {}, None)

        module.request.urlopen = conflict
        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(_event(), None)

        self.assertEqual(result, {"status": "already-settled"})

    def test_missing_original_parameter_fails_closed_without_http(self):
        module = _load_lambda()
        event = _event()
        del event["detail"]["parameters"]
        module.request.urlopen = mock.Mock(side_effect=AssertionError("must not call"))
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = module.handler(event, None)

        self.assertEqual(result, {"status": "rejected-event"})
        module.request.urlopen.assert_not_called()
        self.assertNotIn(USER_SESSION, output.getvalue())

    def test_stage_mismatch_fails_closed(self):
        module = _load_lambda()
        payload = _payload("analyze")
        event = _event(payload=payload, stage="inspect")
        module.request.urlopen = mock.Mock(side_effect=AssertionError("must not call"))

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(event, None)

        self.assertEqual(result, {"status": "rejected-event"})
        module.request.urlopen.assert_not_called()

    def test_invalid_attempt_token_fails_closed_without_http(self):
        module = _load_lambda()
        payload = _payload()
        payload["callback"]["token"] = "A" * 64
        module.request.urlopen = mock.Mock(side_effect=AssertionError("must not call"))

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(_event(payload=payload), None)

        self.assertEqual(result, {"status": "rejected-event"})
        module.request.urlopen.assert_not_called()

    def test_queue_timeout_reason_selects_specific_failure_code(self):
        module = _load_lambda()
        event = _event()
        event["detail"]["statusReason"] = (
            "Opusloops queue credential freshness limit exceeded."
        )
        requests = []
        module.request.urlopen = lambda signed_request, timeout: (
            requests.append(signed_request) or _Response()
        )

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(event, None)

        self.assertEqual(result, {"status": "reported"})
        callback = json.loads(requests[0].data)
        self.assertEqual(callback["error"]["code"], "batch_queue_timeout")
        self.assertEqual(callback["dispatchJobId"], AWS_JOB_ID)
        self.assertNotIn(event["detail"]["statusReason"], requests[0].data.decode())

    def test_template_has_no_project_wide_storage_secret_and_scopes_watchdog_lookup(
        self,
    ):
        template = TEMPLATE_PATH.read_text(encoding="utf-8")
        forbidden = (
            "StorageAccessKeySecretArn",
            "StorageSecretKeySecretArn",
            "OPUSLOOPS_STORAGE_ACCESS_KEY_ID",
            "OPUSLOOPS_STORAGE_SECRET_ACCESS_KEY",
            "CallbackHmacSecretArn",
            "OPUSLOOPS_CALLBACK_HMAC_SECRET",
            "OPUSLOOPS_CALLBACK_SECRET_ARN",
        )
        for value in forbidden:
            self.assertNotIn(value, template)
        self.assertNotIn("ToPort: 53", template)
        self.assertIn("Type: AWS::Events::Rule", template)
        self.assertIn("status: [FAILED]", template)
        self.assertEqual(template.count("Action: batch:DescribeJobs"), 1)
        self.assertIn(
            "Resource: !Sub arn:${AWS::Partition}:batch:${AWS::Region}:${AWS::AccountId}:job/*",
            template,
        )


class QueueWatchdogTests(unittest.TestCase):
    def test_stale_pre_run_job_is_terminated_without_logging_describe_payload(self):
        created_at = 1_700_000_000_000
        job, event = _queue_message(created_at)
        batch = _FakeBatch(job)
        module = _load_queue_watchdog(batch)
        module.time.time = lambda: (created_at + 600_001) / 1000
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = module.handler(event, None)

        self.assertEqual(result, {"status": "terminated"})
        self.assertEqual(batch.describe_calls, [{"jobs": [AWS_JOB_ID]}])
        self.assertEqual(
            batch.terminate_calls,
            [
                {
                    "jobId": AWS_JOB_ID,
                    "reason": "Opusloops queue credential freshness limit exceeded.",
                }
            ],
        )
        self.assertNotIn(USER_SESSION, output.getvalue())
        self.assertNotIn("payload_base64", event["Records"][0]["body"])

    def test_running_job_is_not_terminated(self):
        created_at = 1_700_000_000_000
        job, event = _queue_message(created_at, status="RUNNING")
        batch = _FakeBatch(job)
        module = _load_queue_watchdog(batch)
        module.time.time = lambda: (created_at + 600_001) / 1000

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(event, None)

        self.assertEqual(result, {"status": "no-action"})
        self.assertEqual(batch.terminate_calls, [])


class RetentionInvokerTests(unittest.TestCase):
    def test_hourly_invoker_sends_fixed_bounded_contract_without_logging_secret(self):
        module, secrets = _load_retention_lambda()
        requests = []

        def urlopen(retention_request, timeout):
            requests.append((retention_request, timeout))
            return _Response(b'{"claimed":4,"deleted":3,"failed":1,"remaining":2}')

        module.request.urlopen = urlopen
        output = io.StringIO()
        event = {"source": "aws.events", "detail-type": "Scheduled Event"}

        with contextlib.redirect_stdout(output):
            result = module.handler(event, None)

        self.assertEqual(result, {"status": "completed"})
        self.assertEqual(len(secrets.calls), 1)
        self.assertEqual(len(requests), 1)
        retention_request, timeout = requests[0]
        self.assertEqual(timeout, 8)
        self.assertEqual(retention_request.data, b'{"limit":25}')
        headers = {
            key.lower(): value for key, value in retention_request.header_items()
        }
        self.assertEqual(headers["x-opusloops-maintenance-secret"], MAINTENANCE_SECRET)
        self.assertNotIn(MAINTENANCE_SECRET, output.getvalue())
        self.assertIn('"deleted":3', output.getvalue())

    def test_non_schedule_event_is_rejected_before_secret_read(self):
        module, secrets = _load_retention_lambda()
        module.request.urlopen = mock.Mock(side_effect=AssertionError("must not call"))

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler({"source": "manual"}, None)

        self.assertEqual(result, {"status": "rejected-event"})
        self.assertEqual(secrets.calls, [])
        module.request.urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
