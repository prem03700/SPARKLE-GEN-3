import json
import os
import socket
import subprocess
import sys
import ssl
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

import server


class PrivateServerTests(unittest.TestCase):
    def test_document_extraction_reads_docx_text_and_rejects_bad_inputs(self):
        import io
        import zipfile
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as doc:
            doc.writestr("word/document.xml",
                         '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Robotics dynamics</w:t></w:r></w:p><w:p><w:r><w:t>Joint torque and inertia</w:t></w:r></w:p></w:body></w:document>')
        extracted = server.extract_document_text("notes.docx", archive.getvalue())
        self.assertIn("Robotics dynamics", extracted)
        self.assertIn("Joint torque and inertia", extracted)
        slides = io.BytesIO()
        with zipfile.ZipFile(slides, "w", zipfile.ZIP_DEFLATED) as deck:
            deck.writestr("ppt/slides/slide1.xml",
                          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Slide one title</a:t></p:sld>')
        self.assertIn("Slide one title", server.extract_document_text("deck.pptx", slides.getvalue()))
        with self.assertRaisesRegex(ValueError, "signature"):
            server.extract_document_text("broken.docx", b"not a zip file")
        with self.assertRaisesRegex(ValueError, "Supported document types"):
            server.extract_document_text("archive.exe", b"data")
        with self.assertRaisesRegex(ValueError, "250 KB"):
            server.extract_document_text("large.docx", b"x" * 250_001)

    def test_document_extraction_endpoint_requires_pairing_and_validates_payload(self):
        self.assertEqual(self.request("/api/knowledge/extract", "POST",
                                      {"filename": "notes.docx", "content_base64": "UEsDBA=="})[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST",
                                      {"code": setup["code"], "name": "document extraction test"})
        self.assertEqual(status, 201)
        status, result = self.request("/api/knowledge/extract", "POST",
                                      {"filename": "notes.docx", "content_base64": "bm90IGEgemlw"},
                                      paired["token"])
        self.assertEqual(status, 400)
        self.assertIn("signature", result["error"])
        _, audit = self.request("/api/audit", token=paired["token"])
        self.assertFalse(any(event["event_type"] == "knowledge.document_extracted" for event in audit["events"]))
        import base64
        import io
        import zipfile
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as doc:
            doc.writestr("word/document.xml",
                         '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Private extracted fixture text</w:t></w:r></w:p></w:body></w:document>')
        status, extracted = self.request("/api/knowledge/extract", "POST", {
            "filename": "private-fixture.docx",
            "content_base64": base64.b64encode(archive.getvalue()).decode("ascii")
        }, paired["token"])
        self.assertEqual(status, 200)
        self.assertIn("Private extracted fixture text", extracted["text"])
        _, audit = self.request("/api/audit", token=paired["token"])
        event = next(event for event in audit["events"] if event["event_type"] == "knowledge.document_extracted")
        self.assertIn("extension=.docx", event["summary"])
        self.assertNotIn("Private extracted fixture text", event["summary"])

    def test_chat_context_does_not_inject_unrelated_saved_notes(self):
        messages, memory_used = server.build_chat_context(
            "main", [{"role": "user", "content": "Explain robotics kinematics"}],
            memory_enabled=True,
            knowledge=[
                {"title": "Shopping list", "content": "milk bread apples", "createdAt": "2026-10-11"},
                {"title": "Robotics kinematics", "content": "Forward kinematics maps joint values to pose.", "createdAt": "2026-10-01"},
            ],
        )
        self.assertTrue(memory_used)
        system = messages[0]["content"]
        self.assertIn("Forward kinematics", system)
        self.assertNotIn("Shopping list", system)
        self.assertEqual(messages[-1]["content"], "Explain robotics kinematics")

    def test_chat_context_has_no_recent_note_fallback_when_nothing_matches(self):
        messages, memory_used = server.build_chat_context(
            "main", [{"role": "user", "content": "Explain orbital mechanics"}],
            memory_enabled=True,
            knowledge=[
                {"title": "Shopping list", "content": "milk bread apples", "createdAt": "2026-10-11"},
                {"title": "Gardening", "content": "tomatoes and soil", "createdAt": "2026-10-10"},
            ],
        )
        self.assertFalse(memory_used)
        self.assertNotIn("Shopping list", messages[0]["content"])
        self.assertNotIn("Gardening", messages[0]["content"])

    def test_chat_context_bounds_history_and_keeps_latest_user_message(self):
        messages = [
            {"role": "user", "content": "A" * 700},
            {"role": "assistant", "content": "B" * 700},
            {"role": "user", "content": "latest question"},
        ]
        context, _ = server.build_chat_context("main", messages, history_char_budget=1000)
        history = context[1:]
        self.assertEqual(history[-1]["content"], "latest question")
        self.assertEqual(history[0]["role"], "user", "bounded context must not start with an orphaned assistant turn")
        self.assertLessEqual(sum(len(item["content"]) for item in history), 1000)
        self.assertNotIn("A" * 100, "".join(item["content"] for item in history))

    def test_chat_context_rejects_history_without_final_user_turn(self):
        with self.assertRaisesRegex(ValueError, "last message must be from you"):
            server.build_chat_context("main", [{"role": "assistant", "content": "answer"}])

    def test_health_provider_check_is_cached_between_polls(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit=-1): return json.dumps({"data": [{"id": server.MODEL}]}).encode()
        with patch.dict(server.MODEL_HEALTH_CACHE, {"checked_at": 0.0, "available": False}), \
             patch.object(server, "MODEL_PROVIDER", "nvidia"), \
             patch.object(server, "NVIDIA_API_KEY", "unit-test-key"), \
             patch("server.urllib.request.urlopen", return_value=FakeResponse()) as upstream:
            self.assertTrue(server.selected_model_available())
            self.assertTrue(server.selected_model_available())
            self.assertEqual(upstream.call_count, 1, "rapid health polls should reuse cached provider status")

    def test_non_loopback_server_refuses_to_start_without_tls(self):
        env = os.environ.copy()
        env["SPARKLE_HOST"] = "0.0.0.0"
        env.pop("SPARKLE_TLS_CERT", None)
        env.pop("SPARKLE_TLS_KEY", None)
        result = subprocess.run([sys.executable, "-c", "import server"], env=env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing non-loopback binding without TLS", result.stderr)

    def test_real_tls_listener_serves_content_with_hsts(self):
        with tempfile.TemporaryDirectory() as cert_dir:
            cert = Path(cert_dir) / "server.crt"
            key = Path(cert_dir) / "server.key"
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
                "-keyout", str(key), "-out", str(cert), "-subj", "/CN=localhost",
                "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
                "-addext", "basicConstraints=critical,CA:TRUE",
            ], check=True, capture_output=True, timeout=10)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(str(cert), str(key))
            tls_server = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            tls_server.daemon_threads = True
            tls_server.socket = context.wrap_socket(tls_server.socket, server_side=True)
            tls_thread = threading.Thread(target=tls_server.serve_forever, daemon=True)
            client_context = ssl.create_default_context(cafile=str(cert))
            with patch.object(server, "TLS_ENABLED", True):
                tls_thread.start()
                try:
                    with urlopen(f"https://localhost:{tls_server.server_address[1]}/", context=client_context, timeout=4) as response:
                        self.assertEqual(response.status, 200)
                        self.assertIn(b"SPARKLE GEN-3", response.read())
                        self.assertEqual(response.headers.get("Strict-Transport-Security"), "max-age=31536000")
                        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
                finally:
                    tls_server.shutdown()
                    tls_server.server_close()
                    tls_thread.join(timeout=2)

    def test_private_network_allowlist(self):
        self.assertTrue(server.trusted_network_peer("127.0.0.1"))
        self.assertTrue(server.trusted_network_peer("10.58.17.55"))
        self.assertTrue(server.trusted_network_peer("192.168.1.20"))
        self.assertFalse(server.trusted_network_peer("8.8.8.8"))
        self.assertFalse(server.trusted_network_peer("2001:4860:4860::8888"))

    def test_security_headers_are_present_on_static_and_api_responses(self):
        with urlopen(self.base + "/", timeout=4) as response:
            self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertEqual(response.headers.get("X-Frame-Options"), "DENY")
            self.assertEqual(response.headers.get("Referrer-Policy"), "no-referrer")
            csp = response.headers.get("Content-Security-Policy", "")
            self.assertIn("default-src 'self'", csp)
            self.assertIn("object-src 'none'", csp)
            self.assertIn("frame-ancestors 'none'", csp)
            self.assertEqual(response.headers.get("Cache-Control"), "no-cache")
        with urlopen(self.base + "/api/health", timeout=4) as response:
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_data_dir, self.old_db_path = server.DATA_DIR, server.DB_PATH
        self.old_code, self.old_created = server.PAIR_CODE, server.PAIR_CREATED
        self.old_pair_attempts, self.old_chat_limits, self.old_research_limits = dict(server.PAIR_ATTEMPTS), dict(server.CHAT_LIMITS), dict(server.RESEARCH_LIMITS)
        server.PAIR_ATTEMPTS.clear(); server.CHAT_LIMITS.clear(); server.RESEARCH_LIMITS.clear()
        server.DATA_DIR = Path(self.temp.name)
        server.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        server.initialize()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.httpd.server_address[1])

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.DATA_DIR, server.DB_PATH = self.old_data_dir, self.old_db_path
        server.PAIR_CODE, server.PAIR_CREATED = self.old_code, self.old_created
        server.PAIR_ATTEMPTS.clear(); server.PAIR_ATTEMPTS.update(self.old_pair_attempts)
        server.CHAT_LIMITS.clear(); server.CHAT_LIMITS.update(self.old_chat_limits)
        server.RESEARCH_LIMITS.clear(); server.RESEARCH_LIMITS.update(self.old_research_limits)
        self.temp.cleanup()

    def request(self, path, method="GET", payload=None, token=None):
        headers = {}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer " + token
        req = Request(self.base + path, data=body, headers=headers, method=method)
        try:
            with urlopen(req, timeout=4) as response:
                raw = response.read()
                return response.status, json.loads(raw) if response.headers.get("Content-Type", "").startswith("application/json") else raw
        except HTTPError as exc:
            raw = exc.read()
            try: data = json.loads(raw)
            except Exception: data = raw
            status = exc.code
            exc.close()
            return status, data

    def test_private_boundaries_and_static_file_allowlist(self):
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/index.html")[0], 200)
        self.assertEqual(self.request("/src/app.js")[0], 200)
        self.assertEqual(self.request("/api/health")[0], 200)
        self.assertEqual(self.request("/api/data")[0], 401)
        self.assertEqual(self.request("/api/audit")[0], 401)
        self.assertEqual(self.request("/server.py")[0], 404)
        self.assertEqual(self.request("/src/%2e%2e/server.py")[0], 404)
        self.assertEqual(self.request("/src/%2E%2E/server.py")[0], 404)
        self.assertEqual(self.request("/tests/test_server.py")[0], 404)
        self.assertEqual(self.request("/data/test.sqlite3")[0], 404)


    def test_json_request_boundaries_reject_malformed_and_oversized_bodies(self):
        def raw_post(body, headers=None):
            req = Request(self.base + "/api/setup-code", data=body, headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
            try:
                with urlopen(req, timeout=4) as response:
                    return response.status, json.loads(response.read())
            except HTTPError as exc:
                try: payload = json.loads(exc.read())
                except Exception: payload = {}
                status = exc.code
                exc.close()
                return status, payload
        self.assertEqual(raw_post(b"{")[0], 400)
        # The server intentionally rejects an oversized Content-Length before reading
        # the body. Send only the headers so the client does not race the early close
        # while trying to upload a multi-megabyte payload.
        with socket.create_connection(self.httpd.server_address, timeout=4) as sock:
            sock.sendall(("POST /api/setup-code HTTP/1.1\r\n"
                          "Host: 127.0.0.1\r\n"
                          "Content-Type: application/json\r\n"
                          f"Content-Length: {server.MAX_BODY + 1}\r\n"
                          "Connection: close\r\n\r\n").encode("ascii"))
            response_chunks = []
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response_chunks.append(chunk)
            raw_response = b"".join(response_chunks).decode("utf-8", "replace")
        status_line, response_body = raw_response.split("\r\n\r\n", 1)
        status = int(status_line.split(" ", 2)[1])
        result = json.loads(response_body)
        self.assertEqual(status, 413)
        self.assertIn("too large", result["error"])
        req = Request(self.base + "/api/setup-code", headers={"Transfer-Encoding": "chunked", "Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req, timeout=4) as response:
                status = response.status
        except HTTPError as exc:
            status = exc.code
            exc.close()
        self.assertEqual(status, 400)

    def test_expired_pairing_code_cannot_pair(self):
        _, setup = self.request("/api/setup-code")
        server.PAIR_CREATED = time.time() - server.PAIR_TTL - 1
        self.assertEqual(self.request("/api/setup-code")[0], 410)
        status, result = self.request("/api/pair", "POST", {"code": setup["code"], "name": "expired"})
        self.assertEqual(status, 403)
        self.assertIn("expired", result["error"])

    def test_provider_concurrency_gate_rejects_overload_without_calling_model(self):
        _, setup = self.request("/api/setup-code")
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "overload test"})
        self.assertEqual(status, 201)
        self.assertTrue(server.MODEL_GATE.acquire(blocking=False))
        self.assertTrue(server.MODEL_GATE.acquire(blocking=False))
        try:
            with patch("server.request_model") as model_call:
                status, result = self.request("/api/chat", "POST", {
                    "agent": "main", "messages": [{"role": "user", "content": "Hello"}]
                }, paired["token"])
            self.assertEqual(status, 429)
            self.assertIn("busy", result["error"])
            model_call.assert_not_called()
        finally:
            server.MODEL_GATE.release()
            server.MODEL_GATE.release()

    def test_old_workspace_schema_migrates_revision_without_losing_records(self):
        old_dir, old_path = server.DATA_DIR, server.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as temp:
                server.DATA_DIR = Path(temp)
                server.DB_PATH = Path(temp) / "legacy.sqlite3"
                import sqlite3
                con = sqlite3.connect(server.DB_PATH)
                con.execute("CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT NOT NULL, prefs_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
                legacy_data = {key: [] for key in server.DEFAULT_DATA}
                legacy_data["tasks"] = [{"id": "legacy-task", "title": "keep me"}]
                con.execute("INSERT INTO workspace(id,data_json,prefs_json,updated_at) VALUES(1,?,?,?)", (json.dumps(legacy_data), json.dumps(server.DEFAULT_PREFS), server.now_iso()))
                con.commit(); con.close()
                server.initialize()
                with server.database() as migrated:
                    row = migrated.execute("SELECT data_json,revision FROM workspace WHERE id=1").fetchone()
                self.assertEqual(json.loads(row["data_json"])["tasks"][0]["id"], "legacy-task")
                self.assertEqual(row["revision"], 0)
        finally:
            server.DATA_DIR, server.DB_PATH = old_dir, old_path

    def test_crossref_search_is_authenticated_and_does_not_audit_query_text(self):
        self.assertEqual(self.request("/api/research/search", "POST", {"query": "robotics"})[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "research test"})
        self.assertEqual(status, 201)
        query = "visual SLAM for mobile robots"
        fixture = [{"title": "A Test Paper", "authors": ["A. Researcher"], "year": 2024,
                    "venue": "Robotics Journal", "doi": "10.1234/example.paper", "url": "https://doi.org/10.1234/example.paper", "type": "journal-article"}]
        with patch("server.search_crossref", return_value=fixture) as search:
            status, result = self.request("/api/research/search", "POST", {"query": query}, paired["token"])
        self.assertEqual(status, 200)
        self.assertEqual(result["provider"], "Crossref")
        self.assertEqual(result["results"][0]["url"], fixture[0]["url"])
        search.assert_called_once_with(query)
        _, audit = self.request("/api/audit", token=paired["token"])
        event = next(item for item in audit["events"] if item["event_type"] == "research.search")
        self.assertIn("query_length=", event["summary"])
        self.assertNotIn(query, event["summary"])

    def test_crossref_search_validates_query_before_network_request(self):
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "invalid search test"})
        with patch("server.search_crossref") as search:
            status, result = self.request("/api/research/search", "POST", {"query": " x "}, paired["token"])
        self.assertEqual(status, 400)
        self.assertIn("3–200", result["error"])
        search.assert_not_called()

    def test_crossref_response_is_bounded_and_mapped_to_verified_doi_urls(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit=-1):
                return json.dumps({"message": {"items": [
                    {"title": ["Verified metadata title"], "DOI": "10.5555/valid.1", "author": [{"given": "Ada", "family": "Researcher"}], "published-online": {"date-parts": [[2023, 2]]}, "container-title": ["Journal"]},
                    {"title": ["Bad DOI is excluded"], "DOI": "javascript:alert(1)"},
                ]}}).encode()
        with patch("server.urllib.request.urlopen", return_value=FakeResponse()) as upstream:
            result = server.search_crossref("robotics safety")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["authors"], ["Ada Researcher"])
        self.assertEqual(result[0]["year"], 2023)
        self.assertEqual(result[0]["url"], "https://doi.org/10.5555/valid.1")
        self.assertIn("query.bibliographic=robotics", upstream.call_args.args[0].full_url)

    def test_pairing_and_persistent_workspace_roundtrip(self):
        status, setup = self.request("/api/setup-code")
        self.assertEqual(status, 200)
        old_code = setup["code"]
        status, setup = self.request("/api/setup-code", "POST", {})
        self.assertEqual(status, 200)
        self.assertNotEqual(setup["code"], old_code)
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "test device"})
        self.assertEqual(status, 201)
        token = paired["token"]
        status, session = self.request("/api/session", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(session["device"]["name"], "test device")
        # Pair a second client so stale-write rejection is exercised across devices.
        _, second_code = self.request("/api/setup-code", "POST", {})
        second_status, second_device = self.request("/api/pair", "POST", {"code": second_code["code"], "name": "second sync device"})
        self.assertEqual(second_status, 201)
        second_token = second_device["token"]
        payload = {
            "data": {
                key: [{"id": key + "-1", "title": "persist " + key}]
                for key in server.DEFAULT_DATA
            },
            "preferences": {"theme": "dark", "density": "Compact", "accent": "#123456", "memoryEnabled": True},
            "revision": 0,
        }
        self.assertEqual(self.request("/api/data", "PUT", payload, token)[0], 200)
        status, loaded = self.request("/api/data", token=token)
        self.assertEqual(status, 200)
        for collection in server.DEFAULT_DATA:
            self.assertEqual(loaded["data"][collection][0]["title"], "persist " + collection)
        self.assertEqual(loaded["preferences"]["theme"], "dark")
        self.assertIs(loaded["preferences"]["memoryEnabled"], True)
        self.assertEqual(loaded["revision"], 1)
        # A stale write from a second device must not overwrite newer data.
        stale = dict(payload)
        stale["data"] = {"tasks": [{"id": "t2", "title": "stale write"}]}
        status, conflict = self.request("/api/data", "PUT", stale, second_token)
        self.assertEqual(status, 409)
        self.assertEqual(conflict["revision"], 1)
        _, still_loaded = self.request("/api/data", token=token)
        self.assertEqual(still_loaded["data"]["tasks"][0]["title"], "persist tasks")
        audit_status, audit = self.request("/api/audit", token=token)
        self.assertEqual(audit_status, 200)
        event_types = {event["event_type"] for event in audit["events"]}
        self.assertIn("device.paired", event_types)
        self.assertIn("workspace.updated", event_types)
        self.assertIn("workspace.conflict", event_types)
        # Pairing codes are single-use; a paired device can revoke another device.
        self.assertEqual(self.request("/api/pair", "POST", {"code": setup["code"], "name": "second"} )[0], 403)
        _, next_code = self.request("/api/setup-code", "POST", {})
        status, second = self.request("/api/pair", "POST", {"code": next_code["code"], "name": "revocation test"})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("/api/devices/" + second["device"]["id"], "DELETE", token=token)[0], 200)
        self.assertEqual(self.request("/api/session", token=second["token"])[0], 401)
        self.assertEqual(self.request("/api/signout", "POST", token=token)[0], 200)
        self.assertEqual(self.request("/api/session", token=token)[0], 401)

    def test_pairing_code_is_atomically_single_use_under_concurrency(self):
        status, setup = self.request("/api/setup-code")
        self.assertEqual(status, 200)
        barrier = threading.Barrier(3)
        results = []

        def attempt(name):
            barrier.wait()
            results.append(self.request(
                "/api/pair", "POST", {"code": setup["code"], "name": name}
            )[0])

        workers = [
            threading.Thread(target=attempt, args=("concurrent A",)),
            threading.Thread(target=attempt, args=("concurrent B",)),
        ]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join(timeout=5)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(sorted(results), [201, 403])


    def test_nvidia_key_file_requires_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "gen3.env"
            path.write_text("NVIDIA_API_KEY=fixture-secret\n", encoding="utf-8")
            with patch.dict(os.environ, {"NVIDIA_API_KEY": "", "SPARKLE_LLM_API_KEY": ""}):
                os.chmod(path, 0o600)
                self.assertEqual(server.load_nvidia_api_key(path), "fixture-secret")
                os.chmod(path, 0o644)
                self.assertIsNone(server.load_nvidia_api_key(path))

    def test_nvidia_nemotron_adapter_uses_server_side_key_and_expected_model(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit=-1):
                return json.dumps({"choices":[{"message":{"content":"Nemotron test response"}}]}).encode()

        old = (server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY)
        try:
            server.MODEL_PROVIDER = "nvidia"
            server.MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
            server.NVIDIA_API_KEY = "test-key-never-real"
            captured = {}
            def fake_urlopen(request, timeout):
                captured["url"] = request.full_url
                captured["headers"] = {k.lower(): v for k, v in request.header_items()}
                captured["timeout"] = timeout
                captured["payload"] = json.loads(request.data.decode())
                return FakeResponse()
            with patch("server.urllib.request.urlopen", side_effect=fake_urlopen):
                answer = server.request_model([{"role":"user","content":"test"}])
            self.assertEqual(answer, "Nemotron test response")
            self.assertEqual(captured["url"], server.NVIDIA_CHAT_URL)
            self.assertEqual(captured["headers"]["authorization"], "Bearer test-key-never-real")
            self.assertEqual(captured["payload"]["model"], "nvidia/nemotron-3.5-lightning-30b-a3b")
            self.assertFalse(captured["payload"]["stream"])
            self.assertEqual(captured["payload"]["chat_template_kwargs"], {"enable_thinking": False})
            self.assertEqual(captured["timeout"], 90)
        finally:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = old

    def test_authenticated_chat_api_routes_through_selected_nemotron_provider(self):
        old = (server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY)
        try:
            server.MODEL_PROVIDER = "nvidia"
            server.MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
            server.NVIDIA_API_KEY = None
            _, setup = self.request("/api/setup-code")
            status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "model API test"})
            self.assertEqual(status, 201)
            with patch("server.request_model", return_value="Verified mock response") as model_call:
                status, result = self.request("/api/chat", "POST", {
                    "agent": "main", "messages": [{"role": "user", "content": "Hello"}]
                }, paired["token"])
            self.assertEqual(status, 200)
            self.assertEqual(result["answer"], "Verified mock response")
            self.assertEqual(result["model_provider"], "nvidia")
            self.assertEqual(result["model"], "nvidia/nemotron-3.5-lightning-30b-a3b")
            self.assertFalse(result["local_model"])
            model_call.assert_called_once()
            system_prompt = model_call.call_args.args[0][0]["content"]
            self.assertIn("private chain-of-thought", system_prompt)
            self.assertIn("concise explanations", system_prompt)
        finally:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = old

    def test_streaming_nvidia_adapter_parses_sse_deltas(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def __iter__(self):
                return iter([
                    b'data: {"choices":[{"delta":{"content":"Hello"}}]}',
                    b'data: {"choices":[{"delta":{"content":" world"}}]}',
                    b'data: [DONE]',
                ])
        old = (server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY)
        try:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = "nvidia", "test-model", "unit-test-key"
            with patch("server.urllib.request.urlopen", return_value=FakeResponse()) as upstream:
                self.assertEqual(list(server.stream_model([{"role": "user", "content": "Hello"}])), ["Hello", " world"])
            payload = json.loads(upstream.call_args.args[0].data.decode())
            self.assertTrue(payload["stream"])
            self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": False})
            self.assertEqual(upstream.call_args.args[0].get_header("Authorization"), "Bearer unit-test-key")
            self.assertEqual(upstream.call_args.args[0].get_header("Accept"), "text/event-stream")
        finally:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = old

    def test_streaming_ollama_adapter_parses_json_lines(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def __iter__(self):
                return iter([
                    b'{"message":{"content":"Stream"}}',
                    b'{"message":{"content":"ed"},"done":false}',
                    b'{"done":true}',
                ])
        old = (server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY)
        try:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = "ollama", "test-local", None
            with patch("server.urllib.request.urlopen", return_value=FakeResponse()) as upstream:
                self.assertEqual(list(server.stream_model([{"role": "user", "content": "Hello"}])), ["Stream", "ed"])
            payload = json.loads(upstream.call_args.args[0].data.decode())
            self.assertTrue(payload["stream"])
            self.assertEqual(upstream.call_args.args[0].full_url, server.OLLAMA_URL + "/api/chat")
        finally:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = old

    def test_authenticated_streaming_chat_emits_incremental_events_and_timing(self):
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "stream test"})
        self.assertEqual(status, 201)
        with patch("server.stream_model", return_value=iter(["First ", "second", " answer"])) as model_call:
            status, raw = self.request("/api/chat/stream", "POST", {
                "agent": "main", "messages": [{"role": "user", "content": "Stream this"}]
            }, paired["token"])
        self.assertEqual(status, 200)
        self.assertIsInstance(raw, bytes)
        body = raw.decode("utf-8")
        self.assertIn("event: meta", body)
        self.assertIn("event: delta", body)
        self.assertIn('"text": "First "', body)
        self.assertIn("event: done", body)
        self.assertIn('"answer": "First second answer"', body)
        self.assertIn('"first_token_ms":', body)
        self.assertIn('"elapsed_ms":', body)
        model_call.assert_called_once()
        _, audit = self.request("/api/audit", token=paired["token"])
        event = next(item for item in audit["events"] if item["event_type"] == "chat.response")
        self.assertIn("streaming=true", event["summary"])
        self.assertIn("first_token_ms=", event["summary"])
        self.assertNotIn("Stream this", event["summary"])

    def test_streaming_provider_failure_is_generic_and_releases_capacity(self):
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "stream error test"})
        self.assertEqual(status, 201)
        with patch("server.stream_model", side_effect=RuntimeError("sensitive provider internals")):
            status, raw = self.request("/api/chat/stream", "POST", {
                "agent": "main", "messages": [{"role": "user", "content": "Cause a provider error"}]
            }, paired["token"])
        self.assertEqual(status, 200)
        body = raw.decode("utf-8")
        self.assertIn("event: error", body)
        self.assertIn("Could not complete the selected", body)
        self.assertNotIn("sensitive provider internals", body)
        self.assertTrue(server.MODEL_GATE.acquire(blocking=False), "stream failure must release provider capacity")
        server.MODEL_GATE.release()

    def test_stream_disconnect_closes_upstream_response_promptly(self):
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "stream disconnect test"})
        self.assertEqual(status, 201)
        upstream_closed = threading.Event()
        class FakeUpstream:
            def close(self): upstream_closed.set()
        def blocked_stream(messages, on_response=None):
            response = FakeUpstream()
            if on_response:
                on_response(response)
            yield "first delta"
            if not upstream_closed.wait(3):
                raise AssertionError("client disconnect did not close the upstream response")
            raise OSError("upstream closed after client disconnect")
        req = Request(self.base + "/api/chat/stream",
                      data=json.dumps({"agent": "main", "messages": [{"role": "user", "content": "Cancel this stream"}]}).encode(),
                      headers={"Content-Type": "application/json", "Authorization": "Bearer " + paired["token"]},
                      method="POST")
        with patch("server.stream_model", side_effect=blocked_stream):
            response = urlopen(req, timeout=4)
            try:
                found_delta = False
                for _ in range(12):
                    line = response.readline()
                    if not line:
                        break
                    if b'"text": "first delta"' in line:
                        found_delta = True
                        break
                self.assertTrue(found_delta, "the client should receive an initial streamed delta")
            finally:
                response.close()
            self.assertTrue(upstream_closed.wait(2), "closing the browser stream should close the active upstream response")
        gate_available = False
        for _ in range(50):
            if server.MODEL_GATE.acquire(blocking=False):
                gate_available = True
                break
            time.sleep(0.02)
        self.assertTrue(gate_available, "disconnect must release provider capacity")
        if gate_available:
            server.MODEL_GATE.release()

    def test_nvidia_adapter_fails_closed_without_key_and_does_not_fallback(self):
        old = (server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY)
        try:
            server.MODEL_PROVIDER = "nvidia"
            server.MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
            server.NVIDIA_API_KEY = None
            with patch("server.urllib.request.urlopen") as network:
                with self.assertRaisesRegex(RuntimeError, "not configured"):
                    server.request_model([{"role":"user","content":"test"}])
                network.assert_not_called()
        finally:
            server.MODEL_PROVIDER, server.MODEL, server.NVIDIA_API_KEY = old


if __name__ == "__main__":
    unittest.main()
