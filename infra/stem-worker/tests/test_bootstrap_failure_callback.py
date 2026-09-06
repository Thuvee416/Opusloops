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
WATCHDOG_SCHEDULE_ARN = (
    "arn:aws:events:us-east-1:123456789012:rule/opusloops-stem-worker-queue-watchdog"
)
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
    def __init__(self, jobs=None, summaries_by_status=None, list_responder=None):
        self.jobs = {job["jobId"]: job for job in (jobs or [])}
        self.summaries_by_status = summaries_by_status or {}
        self.list_responder = list_responder
        self.list_calls = []
        self.describe_calls = []
        self.terminate_calls = []

    def list_jobs(self, **kwargs):
        self.list_calls.append(kwargs)
        if self.list_responder is not None:
            return self.list_responder(kwargs)
        return {
            "jobSummaryList": list(
                self.summaries_by_status.get(kwargs["jobStatus"], [])
            )
        }

    def describe_jobs(self, **kwargs):
        self.describe_calls.append(kwargs)
        return {
            "jobs": [
                self.jobs[job_id] for job_id in kwargs["jobs"] if job_id in self.jobs
            ]
        }

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
        "OPUSLOOPS_WATCHDOG_SCHEDULE_ARN": WATCHDOG_SCHEDULE_ARN,
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


def _scheduled_job(created_at, status="RUNNABLE", listed_status=None):
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
    summary = {field: job[field] for field in ("createdAt", "jobId", "jobName")}
    summary["status"] = listed_status or status
    event = {
        "source": "aws.events",
        "detail-type": "Scheduled Event",
        "resources": [WATCHDOG_SCHEDULE_ARN],
    }
    return job, summary, event


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

    def test_template_has_no_project_wide_storage_secret_and_scopes_watchdog_access(
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
        self.assertIn("ScheduleExpression: rate(1 minute)", template)
        self.assertEqual(template.count("Action: batch:ListJobs"), 1)
        self.assertEqual(template.count("Action: batch:DescribeJobs"), 1)
        self.assertEqual(template.count("Action: batch:TerminateJob"), 1)
        self.assertIn(
            "Resource: !Sub arn:${AWS::Partition}:batch:${AWS::Region}:${AWS::AccountId}:job/*",
            template,
        )
        for obsolete in (
            "ReservedConcurrentExecutions",
            "AWS::SQS::Queue",
            "AWS::SQS::QueuePolicy",
            "sqs:",
            "QueueWatchdogDelayQueue",
            "QueueWatchdogEnqueueRule",
            "QueueWatchdogEventSource",
            "OPUSLOOPS_WATCHDOG_QUEUE_ARN",
        ):
            self.assertNotIn(obsolete, template)

    def test_scheduled_watchdog_never_reads_or_logs_batch_parameters(self):
        source = _inline_lambda_source("QueueWatchdogLambda")
        for forbidden in (
            "payload_base64",
            '.get("parameters")',
            '["parameters"]',
            "statusReason",
        ):
            self.assertNotIn(forbidden, source)

    def test_codebuild_publishes_immutable_commit_tag_last(self):
        template = TEMPLATE_PATH.read_text(encoding="utf-8")
        post_build_start = template.index("            post_build:")
        post_build_end = template.index("      Environment:", post_build_start)
        commands = [
            line.strip()
            for line in template[post_build_start:post_build_end].splitlines()
            if line.startswith("                - ")
        ]
        latest_push = '- docker push "${WorkerRepository.RepositoryUri}:latest"'
        immutable_push = '- docker push "${WorkerRepository.RepositoryUri}:$IMAGE_TAG"'

        self.assertLess(commands.index(latest_push), commands.index(immutable_push))
        self.assertEqual(commands[-1], immutable_push)


class QueueWatchdogTests(unittest.TestCase):
    def test_stale_pre_run_job_is_terminated_without_logging_describe_payload(self):
        created_at = 1_700_000_000_000
        job, summary, event = _scheduled_job(created_at)
        batch = _FakeBatch(jobs=[job], summaries_by_status={"RUNNABLE": [summary]})
        module = _load_queue_watchdog(batch)
        module.time.time = lambda: (created_at + 600_001) / 1000
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = module.handler(event, None)

        self.assertEqual(
            result,
            {
                "status": "completed",
                "listed": 1,
                "checked": 1,
                "terminated": 1,
                "rejected": 0,
                "truncated": False,
            },
        )
        self.assertEqual(
            [call["jobStatus"] for call in batch.list_calls],
            ["SUBMITTED", "PENDING", "RUNNABLE", "STARTING"],
        )
        self.assertTrue(all(call["jobQueue"] == QUEUE_ARN for call in batch.list_calls))
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
        self.assertNotIn("payload_base64", output.getvalue())

    def test_running_job_is_not_terminated(self):
        created_at = 1_700_000_000_000
        job, summary, event = _scheduled_job(
            created_at, status="RUNNING", listed_status="RUNNABLE"
        )
        batch = _FakeBatch(jobs=[job], summaries_by_status={"RUNNABLE": [summary]})
        module = _load_queue_watchdog(batch)
        module.time.time = lambda: (created_at + 600_001) / 1000

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(event, None)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["checked"], 1)
        self.assertEqual(result["terminated"], 0)
        self.assertEqual(batch.terminate_calls, [])

    def test_authoritative_binding_mismatch_fails_closed_per_job(self):
        created_at = 1_700_000_000_000
        changes = {
            "jobQueue": "arn:aws:batch:us-east-1:123456789012:job-queue/other",
            "jobDefinition": JOB_DEFINITION_ARNS["analyze"],
            "jobName": f"opusloops-analyze-{JOB_ID[:8]}-{ATTEMPT_ID[:8]}",
            "createdAt": created_at + 1,
        }
        for field, wrong_value in changes.items():
            with self.subTest(field=field):
                job, summary, event = _scheduled_job(created_at)
                job[field] = wrong_value
                batch = _FakeBatch(
                    jobs=[job], summaries_by_status={"RUNNABLE": [summary]}
                )
                module = _load_queue_watchdog(batch)
                module.time.time = lambda: (created_at + 600_001) / 1000

                with contextlib.redirect_stdout(io.StringIO()):
                    result = module.handler(event, None)

                self.assertEqual(result["checked"], 0)
                self.assertEqual(result["terminated"], 0)
                self.assertEqual(result["rejected"], 1)
                self.assertEqual(batch.terminate_calls, [])

    def test_job_is_terminated_at_exact_ten_minute_threshold(self):
        created_at = 1_700_000_000_000
        job, summary, event = _scheduled_job(created_at, status="SUBMITTED")
        batch = _FakeBatch(jobs=[job], summaries_by_status={"SUBMITTED": [summary]})
        module = _load_queue_watchdog(batch)
        module.time.time = lambda: (created_at + 600_000) / 1000

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(event, None)

        self.assertEqual(result["terminated"], 1)
        self.assertEqual(len(batch.terminate_calls), 1)

    def test_fresh_job_is_not_described_or_terminated(self):
        created_at = 1_700_000_000_000
        job, summary, event = _scheduled_job(created_at)
        batch = _FakeBatch(jobs=[job], summaries_by_status={"RUNNABLE": [summary]})
        module = _load_queue_watchdog(batch)
        module.time.time = lambda: (created_at + 599_999) / 1000

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(event, None)

        self.assertEqual(result["checked"], 0)
        self.assertEqual(batch.describe_calls, [])
        self.assertEqual(batch.terminate_calls, [])

    def test_list_pagination_is_bounded_and_reports_truncation(self):
        def list_responder(request):
            page = 1 if "nextToken" not in request else 2
            return {
                "jobSummaryList": [],
                "nextToken": f"{request['jobStatus']}-{page}",
            }

        batch = _FakeBatch(list_responder=list_responder)
        module = _load_queue_watchdog(batch)

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler(
                {
                    "source": "aws.events",
                    "detail-type": "Scheduled Event",
                    "resources": [WATCHDOG_SCHEDULE_ARN],
                },
                None,
            )

        self.assertEqual(len(batch.list_calls), 8)
        self.assertTrue(all(call["maxResults"] == 100 for call in batch.list_calls))
        self.assertTrue(result["truncated"])
        self.assertEqual(batch.describe_calls, [])

    def test_candidate_processing_is_bounded_to_oldest_twenty_five(self):
        created_at = 1_700_000_000_000
        summaries = [
            {
                "jobId": f"{index:08x}-0000-4000-8000-000000000000",
                "jobName": f"opusloops-inspect-{index:08x}-{index + 100:08x}",
                "createdAt": created_at + index,
                "status": "RUNNABLE",
            }
            for index in range(1, 31)
        ]
        batch = _FakeBatch(summaries_by_status={"RUNNABLE": list(reversed(summaries))})
        module = _load_queue_watchdog(batch)

        candidates, listed, rejected, truncated = module._list_candidates(
            created_at + 600_000
        )

        self.assertEqual(listed, 30)
        self.assertEqual(rejected, 0)
        self.assertTrue(truncated)
        self.assertEqual(len(candidates), 25)
        self.assertEqual(candidates[0]["jobId"], summaries[0]["jobId"])
        self.assertEqual(candidates[-1]["jobId"], summaries[24]["jobId"])

    def test_non_schedule_event_is_rejected_before_batch_access(self):
        batch = _FakeBatch()
        module = _load_queue_watchdog(batch)

        with contextlib.redirect_stdout(io.StringIO()):
            result = module.handler({"source": "manual"}, None)

        self.assertEqual(result, {"status": "rejected-event"})
        self.assertEqual(batch.list_calls, [])
        self.assertEqual(batch.describe_calls, [])
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
