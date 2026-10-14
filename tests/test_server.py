import json
import os
import socket
import subprocess
import sys
import ssl
import sqlite3
import urllib.error
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
        with self.assertRaisesRegex(ValueError, "50 MB"):
            server.extract_document_text("large.docx", b"x" * (server.MAX_KNOWLEDGE_IMPORT_BYTES + 1))

    @unittest.skipUnless((Path.home() / ".local/opt/sparkle-ocr/usr/bin/tesseract").is_file() and Path("/usr/bin/pdftoppm").is_file(), "local OCR tools are not available")
    def test_scanned_pdf_uses_bounded_local_ocr_fallback(self):
        calls = []
        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            if command[0] == "/usr/bin/pdftotext":
                return subprocess.CompletedProcess(command, 0, stdout=b"")
            if command[0] == "/usr/bin/pdftoppm":
                from PIL import Image
                Path(command[-1] + "-1.png").write_bytes(b"fixture image; renderer mocked")
                return subprocess.CompletedProcess(command, 0, stdout=b"")
            if command[0].endswith("/tesseract"):
                return subprocess.CompletedProcess(command, 0, stdout=b"Scanned robotics notes and joint torque.")
            raise AssertionError("unexpected subprocess command")
        with patch("subprocess.run", side_effect=fake_run):
            extracted = server.extract_document_text("scanned-notes.pdf", b"%PDF-1.7\nfixture")
        self.assertIn("OCR-extracted text", extracted)
        self.assertIn("Scanned robotics notes", extracted)
        render = next(command for command, _ in calls if command[0] == "/usr/bin/pdftoppm")
        self.assertEqual(render[render.index("-l") + 1], "5", "OCR must be bounded to five pages")
        self.assertEqual(render[render.index("-r") + 1], "150", "OCR rendering must use bounded resolution")
        self.assertTrue(any(command[0].endswith("/tesseract") for command, _ in calls))

    def test_chat_attachment_upload_is_authenticated_bounded_and_stored_separately(self):
        self.assertEqual(self.request("/api/chat/attachments", "POST")[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {
            "code": setup["code"], "name": "chat attachment test"
        })
        self.assertEqual(status, 201)
        token = paired["token"]
        from urllib.request import Request, urlopen
        payload = b"print('large upload endpoint test')\n"
        request = Request(self.base + "/api/chat/attachments", data=payload, method="POST", headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/octet-stream",
            "X-Attachment-Name": "robot.py",
        })
        with urlopen(request, timeout=4) as response:
            self.assertEqual(response.status, 201)
            result = json.loads(response.read())
        self.assertRegex(result["id"], r"^[0-9a-f]{32}$")
        self.assertEqual(result["name"], "robot.py")
        with server.database() as con:
            row = con.execute("SELECT content,size_bytes,created_by FROM chat_attachments WHERE id=?", (result["id"],)).fetchone()
        self.assertEqual(row["content"], payload.decode())
        self.assertEqual(row["size_bytes"], len(payload))
        self.assertTrue(row["created_by"])
        bad = Request(self.base + "/api/chat/attachments", data=b"\x00\x01", method="POST", headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/octet-stream",
            "X-Attachment-Name": "robot.py",
        })
        with self.assertRaises(HTTPError) as caught:
            urlopen(bad, timeout=4)
        self.assertEqual(caught.exception.code, 400)

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

    def test_knowledge_ranker_weights_title_matches_and_excludes_unrelated_notes(self):
        notes = [
            {"title": "Robotics kinematics", "content": "Forward kinematics maps joints to pose.", "createdAt": "2026-10-01"},
            {"title": "General scratchpad", "content": ("robotics kinematics " * 30) + "miscellaneous notes", "createdAt": "2026-10-11"},
            {"title": "Garden planning", "content": "Tomatoes need sunlight and soil.", "createdAt": "2026-10-12"},
        ]
        ranked = server.rank_knowledge_notes("robotics kinematics", notes, limit=2)
        self.assertEqual(len(ranked), 2)
        self.assertEqual(ranked[0]["title"], "Robotics kinematics", "title and exact phrase relevance should outweigh repeated body terms")
        self.assertNotIn("Garden planning", [item["title"] for item in ranked])
        self.assertEqual(server.rank_knowledge_notes("unrelated orbital mechanics", notes), [])

    def test_local_semantic_knowledge_search_caches_vectors_and_returns_note_ids(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("CREATE TABLE knowledge_embeddings(note_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
        notes = [
            {"id": "robot-note", "title": "Robot joint movement", "content": "Actuator torque moves robot joints through kinematic chains.", "createdAt": "2026-10-10"},
            {"id": "garden-note", "title": "Garden soil", "content": "Tomatoes need water and sunlight.", "createdAt": "2026-10-11"},
        ]
        def fake_embeddings(texts):
            def vec(text):
                lower = text.lower()
                if "robot" in lower or "actuator" in lower or "kinematic" in lower:
                    return [1.0, 0.0, 0.0] + [0.0] * 29
                if "water" in lower or "tomato" in lower or "garden" in lower:
                    return [0.0, 1.0, 0.0] + [0.0] * 29
                return [0.9, 0.1, 0.0] + [0.0] * 29
            return [vec(text) for text in texts]
        with patch("server._local_embeddings", side_effect=fake_embeddings) as embed:
            result = server.semantic_search_knowledge(con, "How do robot actuators move joints?", notes)
            self.assertEqual(result["mode"], "local-semantic")
            self.assertEqual(result["results"][0]["id"], "robot-note")
            self.assertNotIn("garden-note", [item["id"] for item in result["results"]])
            first_call_count = embed.call_count
            cached = server.semantic_search_knowledge(con, "How do robot actuators move joints?", notes)
            self.assertEqual(cached["results"][0]["id"], "robot-note")
            self.assertEqual(embed.call_count, first_call_count + 1, "the second search should embed only the new query")
        self.assertEqual(con.execute("SELECT COUNT(*) FROM knowledge_embeddings").fetchone()[0], 2)
        con.close()

    def test_local_semantic_knowledge_search_falls_back_to_lexical_when_local_model_unavailable(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("CREATE TABLE knowledge_embeddings(note_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
        notes = [{"id": "n1", "title": "Robot kinematics", "content": "Joint pose calculation", "createdAt": "2026-10-10"}]
        with patch("server._local_embeddings", side_effect=urllib.error.URLError("local embedding service unavailable")):
            result = server.semantic_search_knowledge(con, "robot kinematics", notes)
        self.assertEqual(result["mode"], "lexical-fallback")
        self.assertEqual(result["results"][0]["id"], "n1")
        con.close()

    def test_knowledge_semantic_search_endpoint_requires_pairing_and_returns_mode(self):
        self.assertEqual(self.request("/api/knowledge/search", "POST", {"query": "robot movement"})[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "semantic search test"})
        with patch("server.semantic_search_knowledge", return_value={"results": [{"id": "note-1", "title": "Robot", "content": "Moves", "score": 0.8}], "mode": "local-semantic", "considered_notes": 1}) as search:
            status, result = self.request("/api/knowledge/search", "POST", {"query": "robot movement", "limit": 10}, paired["token"])
        self.assertEqual(status, 200)
        self.assertEqual(result["mode"], "local-semantic")
        self.assertEqual(result["results"][0]["id"], "note-1")
        search.assert_called_once()

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

    def test_opted_in_chat_memory_uses_semantic_retrieval_before_model_call(self):
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "semantic memory test"})
        with server.database() as con:
            row = server.read_workspace(con)
            data = row["data"]
            data["knowledge"] = [{"id": "semantic-chat-note", "title": "Joint torque fundamentals", "content": "Actuator current creates torque that opposes external load.", "createdAt": "2026-10-10"}]
            preferences = dict(row["preferences"]); preferences["memoryEnabled"] = True
            con.execute("UPDATE workspace SET data_json=?,prefs_json=?,revision=revision+1 WHERE id=1",
                        (json.dumps(data), json.dumps(preferences)))
        semantic_result = {"results": [{"id": "semantic-chat-note", "title": "Joint torque fundamentals", "content": "Actuator current creates torque that opposes external load.", "score": 0.72}], "mode": "local-semantic", "considered_notes": 1}
        captured = {}
        def model(messages):
            captured["messages"] = messages
            return "The actuator creates joint torque."
        with patch("server.semantic_search_knowledge", return_value=semantic_result) as retrieval, patch("server.request_model", side_effect=model):
            status, result = self.request("/api/chat", "POST", {"agent": "main", "messages": [{"role": "user", "content": "Why does the arm resist motion?"}]}, paired["token"])
        self.assertEqual(status, 200)
        self.assertTrue(result["memory_used"])
        self.assertIn("Joint torque fundamentals", captured["messages"][0]["content"])
        self.assertIn("opposes external load", captured["messages"][0]["content"])
        retrieval.assert_called_once()

    def test_chat_context_accepts_explicitly_semantic_ranked_notes_without_lexical_overlap(self):
        messages, memory_used = server.build_chat_context(
            "main", [{"role": "user", "content": "Why does the robot arm resist movement?"}],
            memory_enabled=True, knowledge=[{
                "id": "semantic-note", "title": "Joint torque fundamentals",
                "content": "Actuator current creates torque that opposes external load.", "score": 0.71,
            }], knowledge_pre_ranked=True,
        )
        self.assertTrue(memory_used)
        self.assertIn("Joint torque fundamentals", messages[0]["content"])
        self.assertIn("opposes external load", messages[0]["content"])

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

    def test_visual_prompt_documents_all_supported_blocks_and_tangent_constraints(self):
        context, _ = server.build_chat_context("main", [{"role": "user", "content": "Explain a derivative visually"}])
        prompt = context[0]["content"]
        for block_type in ("sparkle-card", "sparkle-table", "sparkle-chart", "sparkle-diagram", "sparkle-prompt", "sparkle-graph", "sparkle-steps", "sparkle-robot_arm"):
            self.assertIn(block_type, prompt)
        self.assertIn("tangent?:{kind:quadratic,x:number}", prompt)
        self.assertIn("robot_arm={title?,link1:positive number,link2:positive number}", prompt)

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
            self.assertIn("img-src 'self' data: blob:", csp)
            self.assertIn("media-src 'self' blob:", csp)
            expected_socket_scheme = "wss" if server.TLS_ENABLED else "ws"
            self.assertIn(f"connect-src 'self' {expected_socket_scheme}://", csp)
            self.assertNotIn(" ws: wss:", csp)
            self.assertNotIn(" ws:;", csp)
            self.assertNotIn(" wss:;", csp)
            self.assertIn("microphone=(self)", response.headers.get("Permissions-Policy", ""))
            self.assertEqual(response.headers.get("Cache-Control"), "no-cache")
        with urlopen(self.base + "/api/health", timeout=4) as response:
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_data_dir, self.old_db_path = server.DATA_DIR, server.DB_PATH
        self.old_code, self.old_created = server.PAIR_CODE, server.PAIR_CREATED
        self.old_pair_attempts, self.old_chat_limits, self.old_research_limits, self.old_core_proposal_limits = dict(server.PAIR_ATTEMPTS), dict(server.CHAT_LIMITS), dict(server.RESEARCH_LIMITS), dict(server.CORE_PROPOSAL_LIMITS)
        server.PAIR_ATTEMPTS.clear(); server.CHAT_LIMITS.clear(); server.RESEARCH_LIMITS.clear(); server.CORE_PROPOSAL_LIMITS.clear()
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
        server.CORE_PROPOSAL_LIMITS.clear(); server.CORE_PROPOSAL_LIMITS.update(self.old_core_proposal_limits)
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

    def test_personal_core_proposals_are_authenticated_durable_and_never_execute(self):
        self.assertEqual(self.request("/api/core/proposals")[0], 401)
        self.assertEqual(self.request("/api/core/proposals", "POST", {
            "action_type": "create_task", "title": "Unauthenticated proposal"
        })[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {
            "code": setup["code"], "name": "Personal Core proposal test"
        })
        self.assertEqual(status, 201)
        token = paired["token"]
        status, invalid = self.request("/api/core/proposals", "POST", {
            "action_type": "unknown_action", "title": "Not allowed"
        }, token)
        self.assertEqual(status, 400)
        status, malformed_type = self.request("/api/core/proposals", "POST", {
            "action_type": ["shell_execution"], "title": "Must be rejected"
        }, token)
        self.assertEqual(status, 400)
        status, created = self.request("/api/core/proposals", "POST", {
            "action_type": "shell_execution", "title": "Run command",
            "details": "This stays disabled."
        }, token)
        self.assertEqual(status, 201)
        self.assertFalse(created["executed"])
        proposal = created["proposal"]
        self.assertEqual(proposal["status"], "proposed")
        self.assertEqual(proposal["action_type"], "shell_execution")
        status, listed = self.request("/api/core/proposals", token=token)
        self.assertEqual(status, 200)
        self.assertFalse(listed["execution_enabled"])
        self.assertEqual(listed["proposals"][0]["id"], proposal["id"])
        status, decision = self.request(
            f"/api/core/proposals/{proposal['id']}/decision", "POST",
            {"decision": "approved"}, token,
        )
        self.assertEqual(status, 200)
        self.assertFalse(decision["executed"])
        self.assertEqual(decision["status"], "approved")
        status, repeated = self.request(
            f"/api/core/proposals/{proposal['id']}/decision", "POST",
            {"decision": "rejected"}, token,
        )
        self.assertEqual(status, 409)
        status, listed = self.request("/api/core/proposals", token=token)
        self.assertEqual(listed["proposals"][0]["status"], "approved")
        status, task_proposal = self.request("/api/core/proposals", "POST", {
            "action_type": "create_task", "title": "Explicitly approved task",
            "details": "Created only after approval",
        }, token)
        self.assertEqual(status, 201)
        status, task_decision = self.request(
            f"/api/core/proposals/{task_proposal['proposal']['id']}/decision", "POST",
            {"decision": "approved"}, token,
        )
        self.assertEqual(status, 200)
        self.assertTrue(task_decision["executed"])
        self.assertEqual(task_decision["execution_result"]["collection"], "tasks")
        status, snapshot = self.request("/api/data", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(len([item for item in snapshot["data"]["tasks"] if item["title"] == "Explicitly approved task"]), 1)
        _, audit = self.request("/api/audit", token=token)
        events = [item["event_type"] for item in audit["events"]]
        self.assertIn("core.proposal.created", events)
        self.assertIn("core.proposal.decided", events)

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

    def test_public_web_search_parses_bounded_results_and_source_retrieval_extracts_text(self):
        from urllib.parse import urlparse
        class FakeResponse:
            def __init__(self, body, content_type="text/html; charset=utf-8"):
                self.body = body.encode("utf-8")
                self.headers = {"Content-Type": content_type}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit=-1): return self.body[:limit]
        class FakeOpener:
            def __init__(self, response): self.response = response
            def open(self, request, timeout=0): return self.response
        search_html = '<div class="result"><a class="result__a" href="https://example.edu/paper">Robotics <b>study</b></a><a class="result__snippet">A useful evidence snippet.</a></div>'
        with patch("server.urllib.request.build_opener", return_value=FakeOpener(FakeResponse(search_html))), \
             patch("server._public_https_url", side_effect=lambda value: urlparse(value) if value.startswith("https://") else None):
            results = server.search_public_web("robotics evidence")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Robotics study")
        self.assertIn("useful evidence snippet", results[0]["snippet"])
        self.assertEqual(results[0]["domain"], "example.edu")
        source_id = results[0]["source_id"]
        page_html = '<html><head><title>Robotics paper</title><meta name="author" content="A. Researcher"><meta name="citation_publication_date" content="2026-05-10"><meta name="citation_doi" content="10.1234/robotics"><meta name="description" content="Paper abstract"></head><body><nav>Menu</nav><main><p>We evaluate a robotics method on three datasets.</p><p>Results have limitations.</p><script>secret tracking</script></main></body></html>'
        with patch("server.urllib.request.build_opener", return_value=FakeOpener(FakeResponse(page_html))), \
             patch("server._resolve_public_https_url", side_effect=lambda value: (urlparse(value), "93.184.216.34") if value.startswith("https://") else None):
            source = server.retrieve_public_source(source_id)
        self.assertIn("Robotics paper", source["title"])
        self.assertIn("evaluate a robotics method", source["text"])
        self.assertNotIn("secret tracking", source["text"])
        self.assertIn("unverified", source["verification_note"])
        self.assertEqual(source["metadata"].get("author"), "A. Researcher")
        self.assertEqual(source["metadata"].get("published"), "2026-05-10")
        self.assertEqual(source["metadata"].get("doi"), "10.1234/robotics")

    def test_public_web_search_requires_pairing_and_keeps_query_out_of_audit(self):
        query = "private robotics research phrase"
        self.assertEqual(self.request("/api/research/web-search", "POST", {"query": query})[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "web research test"})
        self.assertEqual(status, 201)
        fixture = [{"source_id": "abcdefghijklmnopqrstuvwxyz", "title": "Public source", "url": "https://example.edu/paper", "domain": "example.edu", "snippet": "Fixture snippet", "quality_hint": "academic or government domain"}]
        with patch("server.search_public_web", return_value=fixture) as search:
            status, result = self.request("/api/research/web-search", "POST", {"query": query}, paired["token"])
        self.assertEqual(status, 200)
        self.assertEqual(result["provider"], "Public web search")
        self.assertEqual(result["results"][0]["domain"], "example.edu")
        search.assert_called_once_with(query)
        _, audit = self.request("/api/audit", token=paired["token"])
        event = next(item for item in audit["events"] if item["event_type"] == "research.web_search")
        self.assertIn("query_length=", event["summary"])
        self.assertNotIn(query, event["summary"])

    def test_public_source_retrieval_requires_cached_search_result_and_is_authenticated(self):
        source_id = "abcdefghijklmnopqrstuvwxyz"
        self.assertEqual(self.request("/api/research/fetch", "POST", {"source_id": source_id})[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "source retrieval test"})
        with patch("server.retrieve_public_source", return_value={"title": "Fixture source", "url": "https://example.org/source", "domain": "example.org", "text": "Readable evidence excerpt", "truncated": False, "verification_note": "Unverified source"}) as retrieve:
            status, result = self.request("/api/research/fetch", "POST", {"source_id": source_id}, paired["token"])
        self.assertEqual(status, 200)
        self.assertIn("Readable evidence excerpt", result["text"])
        retrieve.assert_called_once_with(source_id)
        with patch("server.retrieve_public_source") as retrieve:
            status, result = self.request("/api/research/fetch", "POST", {"source_id": "not a source id"}, paired["token"])
        self.assertEqual(status, 400)
        retrieve.assert_not_called()

    def test_public_source_url_validator_rejects_private_hosts_and_non_https(self):
        for url in ("http://example.com/page", "https://127.0.0.1/secret", "https://localhost/", "https://192.168.1.2/", "https://user:pass@example.com/"):
            self.assertIsNone(server._public_https_url(url), url)
        with patch("server.socket.getaddrinfo", return_value=[(None, None, None, None, ("10.0.0.2", 443))]):
            self.assertIsNone(server._public_https_url("https://rebind.example/path"))

    def test_python_rd_sweep_endpoint_requires_pairing_and_returns_bounded_results(self):
        status, denied = self.request("/api/rd/sweep", "POST", {
            "model": "pendulum", "parameter": "damping", "values": [0, .15, .35, .7, 1.2]
        })
        self.assertEqual(status, 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        status, paired = self.request("/api/pair", "POST", {
            "code": setup["code"], "name": "Python simulation test"
        })
        self.assertEqual(status, 201)
        token = paired["token"]
        payload = {"model": "pendulum", "parameter": "damping",
                   "values": [0, .15, .35, .7, 1.2],
                   "base": {"gravity": 9.81, "length": 1.6, "angle": 30}}
        status, result = self.request("/api/rd/sweep", "POST", payload, token)
        self.assertEqual(status, 200)
        self.assertEqual(result["engine"], "SPARKLE Python deterministic model")
        self.assertEqual(len(result["results"]), 5)
        self.assertTrue(all(row["steps"] == 1800 for row in result["results"]))
        status, invalid = self.request("/api/rd/sweep", "POST",
            {**payload, "values": [0, .1]}, token)
        self.assertEqual(status, 400)
        self.assertIn("exactly five", invalid["error"])
        _, audit = self.request("/api/audit", token=token)
        self.assertTrue(any(event["event_type"] == "rd.experiment_sweep" for event in audit["events"]))

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
            self.assertEqual(captured["timeout"], 180)
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


    def test_authenticated_image_generation_persists_private_artifact_without_prompt_logging(self):
        self.assertEqual(self.request("/api/images/generate", "POST", {"prompt": "a red robot"} )[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "image test"})
        status, invalid = self.request("/api/images/generate", "POST", {"prompt": "x"}, paired["token"])
        self.assertEqual(status, 400)
        self.assertIn("at least 3", invalid["error"])
        fixture = b"\x89PNG\r\n\x1a\nprivate-image-fixture"
        long_prompt = "a red robot " * 150
        with patch("server.request_generated_image", return_value=(fixture, "image/png", ".png")) as generator:
            status, result = self.request("/api/images/generate", "POST", {"prompt": long_prompt}, paired["token"])
            generator.assert_called_once_with(long_prompt.strip())
        self.assertEqual(status, 201)
        self.assertRegex(result["id"], r"^[0-9a-f]{32}$")
        self.assertEqual(result["mime_type"], "image/png")
        self.assertEqual(self.request("/api/images/" + result["id"])[0], 401)
        req = Request(self.base + "/api/images/" + result["id"],
                      headers={"Authorization": "Bearer " + paired["token"]})
        with urlopen(req, timeout=4) as response:
            self.assertEqual(response.headers.get("Content-Type"), "image/png")
            self.assertEqual(response.read(), fixture)
        _, audit = self.request("/api/audit", token=paired["token"])
        event = next(item for item in audit["events"] if item["event_type"] == "image.generated")
        self.assertIn("bytes=", event["summary"])
        self.assertNotIn("a red robot", event["summary"])
        self.assertEqual(self.request("/api/images/" + result["id"], "DELETE")[0], 401)
        self.assertEqual(self.request("/api/images/" + result["id"], "DELETE", token=paired["token"])[0], 200)
        self.assertEqual(self.request("/api/images/" + result["id"], token=paired["token"])[0], 404)

    def test_image_provider_adapter_uses_server_key_and_rejects_bad_image_payloads(self):
        import base64
        old_key = server.NVIDIA_API_KEY
        try:
            server.NVIDIA_API_KEY = "fixture-image-key"
            image = b"\x89PNG\r\n\x1a\nimage"
            class FakeResponse:
                headers = {}
                def __enter__(self): return self
                def __exit__(self, *args): return False
                def read(self, limit=-1): return json.dumps({"data":[{"b64_json":base64.b64encode(image).decode()}]}).encode()
            captured = {}
            class FakeOpener:
                def open(self, request, timeout):
                    captured["url"] = request.full_url
                    captured["authorization"] = request.get_header("Authorization")
                    captured["payload"] = json.loads(request.data.decode())
                    captured["timeout"] = timeout
                    return FakeResponse()
            with patch("server.urllib.request.build_opener", return_value=FakeOpener()):
                data, mime, extension = server.request_generated_image("a clean test image")
            self.assertEqual(data, image)
            self.assertEqual((mime, extension), ("image/png", ".png"))
            self.assertEqual(captured["url"], server.NVIDIA_IMAGE_URL)
            self.assertEqual(captured["authorization"], "Bearer fixture-image-key")
            self.assertNotIn("model", captured["payload"])
            self.assertNotIn("mode", captured["payload"])
            self.assertEqual(captured["payload"]["cfg_scale"], 1)
            self.assertEqual(captured["timeout"], 120)
            class BadResponse(FakeResponse):
                def read(self, limit=-1): return json.dumps({"data":[{"b64_json":"bm90YW5pbWFnZQ=="}]}).encode()
            with patch("server.urllib.request.build_opener", return_value=type("Opener", (), {"open": lambda self, request, timeout: BadResponse()})()):
                with self.assertRaisesRegex(ValueError, "unsupported image format"):
                    server.request_generated_image("a clean test image")
        finally:
            server.NVIDIA_API_KEY = old_key

    def test_realtime_voice_is_gemini_only_and_disabled_without_gemini_key(self):
        self.assertFalse(server.valid_private_voicechat_url(""))
        self.assertTrue(server.valid_private_voicechat_url("ws://127.0.0.1:8080/v1/realtime"))
        self.assertFalse(server.valid_private_voicechat_url("wss://example.com/v1/realtime"))
        self.assertFalse(server.valid_private_voicechat_url("http://user:pass@127.0.0.1:9000/api/offer"))
        self.assertEqual(self.request("/api/voice/offer", "POST", {"sdp": "v=0\r\n"})[0], 401)
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code": setup["code"], "name": "voice test"})
        old_key, old_url = server.GEMINI_API_KEY, server.VOICECHAT_URL
        try:
            server.GEMINI_API_KEY = ""
            server.VOICECHAT_URL = "ws://127.0.0.1:8080/v1/realtime"
            self.assertEqual(server.voicechat_transport(), "none")
            health_status, health = self.request("/api/health")
            self.assertEqual(health_status, 200)
            self.assertFalse(health["realtime_voice_supported"])
            status, disabled = self.request("/api/voice/ws", "GET", token=paired["token"])
            self.assertEqual(status, 503)
            server.GEMINI_API_KEY = "gemini-fixture-key"
            self.assertEqual(server.voicechat_transport(), "websocket")
            self.assertTrue(server.valid_private_voicechat_url(server.VOICECHAT_URL))
            # Legacy WebRTC/Nemotron endpoints must not become an alternate voice provider.
            status, disabled = self.request("/api/voice/offer", "POST", {"sdp": "v=0\r\n"}, paired["token"])
            self.assertEqual(status, 503)
        finally:
            server.GEMINI_API_KEY, server.VOICECHAT_URL = old_key, old_url

    def test_optional_voice_configuration_requires_owner_only_file_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "gen3.env"
            path.write_text("SPARKLE_VOICECHAT_URL=http://127.0.0.1:9000/api/offer\nSPARKLE_VOICECHAT_TOKEN=private-fixture\n", encoding="utf-8")
            with patch.dict(os.environ, {"SPARKLE_VOICECHAT_URL": "", "SPARKLE_VOICECHAT_TOKEN": ""}):
                os.chmod(path, 0o600)
                self.assertEqual(server.load_private_runtime_value("SPARKLE_VOICECHAT_URL", path), "http://127.0.0.1:9000/api/offer")
                self.assertEqual(server.load_private_runtime_value("SPARKLE_VOICECHAT_TOKEN", path), "private-fixture")
                os.chmod(path, 0o644)
                self.assertEqual(server.load_private_runtime_value("SPARKLE_VOICECHAT_URL", path), "")

    def test_gemini_live_upstream_uses_fixed_tls_host_and_server_side_key(self):
        import base64
        import hashlib
        old_key = server.GEMINI_API_KEY
        server.GEMINI_API_KEY = "fixture-key-123"
        captured = {}
        class FakeSocket:
            def __init__(self): self.response = bytearray(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n")
            def settimeout(self, value): pass
            def sendall(self, data): captured["request"] = data.decode("ascii")
            def recv(self, size):
                if self.response:
                    chunk = self.response[:size]
                    del self.response[:size]
                    return bytes(chunk)
                return b""
            def close(self): pass
        fake = FakeSocket()
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        accept = base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
        fake.response.extend(("Sec-WebSocket-Accept: "+accept+"\r\n\r\n").encode("ascii"))
        class FakeTLS:
            def wrap_socket(self, sock, server_hostname):
                captured["tls_hostname"] = server_hostname
                return sock
        # Capture the generated client key so the fake upstream can return a valid accept.
        def fake_sendall(data):
            captured["request"] = data.decode("ascii")
            request_key = next(line.split(":",1)[1].strip() for line in captured["request"].split("\r\n") if line.lower().startswith("sec-websocket-key:"))
            expected = base64.b64encode(hashlib.sha1((request_key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
            fake.response = bytearray(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+expected+"\r\n\r\n").encode("ascii"))
        fake.sendall = fake_sendall
        try:
            with patch("server.socket.create_connection", return_value=fake) as connect, patch("server.ssl.create_default_context", return_value=FakeTLS()):
                result = server._voice_upstream_socket()
            self.assertIs(result, fake)
            connect.assert_called_once_with(("generativelanguage.googleapis.com", 443), timeout=12)
            self.assertEqual(captured["tls_hostname"], "generativelanguage.googleapis.com")
            request = captured["request"]
            self.assertIn("Host: generativelanguage.googleapis.com", request)
            self.assertIn("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=fixture-key-123", request)
            self.assertNotIn("Authorization:", request)
        finally:
            server.GEMINI_API_KEY = old_key

    def test_authenticated_gemini_live_websocket_relay(self):
        import base64
        import hashlib
        old_key = server.GEMINI_API_KEY
        server.GEMINI_API_KEY = "gemini-fixture-key"
        upstream_listener = socket.socket()
        upstream_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        upstream_listener.bind(("127.0.0.1", 0))
        upstream_listener.listen(1)
        upstream_port = upstream_listener.getsockname()[1]
        upstream_events, upstream_done, upstream_errors = [], threading.Event(), []

        def read_headers(conn):
            raw = bytearray()
            while not raw.endswith(b"\r\n\r\n") and len(raw) < 16384:
                item = conn.recv(1)
                if not item: break
                raw.extend(item)
            return bytes(raw)

        def connect_fixture_upstream():
            conn = socket.create_connection(("127.0.0.1", upstream_port), timeout=4)
            conn.settimeout(4)
            key = base64.b64encode(os.urandom(16)).decode()
            conn.sendall(("GET /fixture HTTP/1.1\r\nHost: fixture\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "+key+"\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            response = read_headers(conn).decode("iso-8859-1")
            if "101 Switching Protocols" not in response:
                conn.close()
                raise ConnectionError("fixture upstream rejected websocket handshake")
            return conn

        def upstream_server():
            conn = None
            try:
                conn, _ = upstream_listener.accept()
                conn.settimeout(4)
                request = read_headers(conn).decode("iso-8859-1")
                upstream_events.append(("request", request))
                key = next(line.split(":",1)[1].strip() for line in request.split("\r\n") if line.lower().startswith("sec-websocket-key:"))
                accept = base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n").encode())
                opcode, payload = server._read_client_websocket_frame(conn, 65536)
                setup_event = json.loads(payload.decode())
                upstream_events.append(("setup", setup_event))
                conn.sendall(server._server_websocket_frame(json.dumps({"setupComplete":{}}).encode()))
                opcode, payload = server._read_client_websocket_frame(conn, 65536)
                audio_event = json.loads(payload.decode())
                upstream_events.append(("audio", audio_event))
                response = {"serverContent":{"outputTranscription":{"text":"Hello from Gemini fixture"},"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"AQACAAMA"}}]}}}
                conn.sendall(server._server_websocket_frame(json.dumps(response).encode()))
                upstream_done.set()
            except Exception as exc:
                upstream_errors.append(type(exc).__name__ + ": " + str(exc))
                upstream_done.set()
            finally:
                if conn:
                    try: conn.close()
                    except OSError: pass
                upstream_listener.close()

        thread = threading.Thread(target=upstream_server, daemon=True)
        thread.start()
        _, setup = self.request("/api/setup-code", "POST", {})
        _, paired = self.request("/api/pair", "POST", {"code":setup["code"],"name":"Gemini voice websocket test"})

        def masked_frame(payload, opcode=1):
            payload = bytes(payload)
            mask = b"abcd"
            length = len(payload)
            if length < 126: header = bytes([0x80|opcode,0x80|length])
            elif length <= 65535: header = bytes([0x80|opcode,0x80|126])+length.to_bytes(2,"big")
            else: header = bytes([0x80|opcode,0x80|127])+length.to_bytes(8,"big")
            return header+mask+bytes(value^mask[i%4] for i,value in enumerate(payload))

        def receive_frame(conn):
            first, second = conn.recv(1), conn.recv(1)
            if not first or not second: raise ConnectionError("WebSocket closed before expected frame")
            size=second[0]&0x7f
            if size==126: size=int.from_bytes(server._socket_read_exact(conn,2),"big")
            elif size==127: size=int.from_bytes(server._socket_read_exact(conn,8),"big")
            payload=server._socket_read_exact(conn,size)
            return first[0]&0x0f,payload

        def browser_socket(token):
            conn=socket.create_connection(self.httpd.server_address,timeout=4)
            conn.settimeout(4)
            key=base64.b64encode(os.urandom(16)).decode()
            conn.sendall(("GET /api/voice/ws HTTP/1.1\r\nHost: 127.0.0.1:"+str(self.httpd.server_address[1])+"\r\nOrigin: "+self.base+"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "+key+"\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            response=read_headers(conn).decode("iso-8859-1")
            self.assertIn("101 Switching Protocols",response)
            conn.sendall(masked_frame(json.dumps({"type":"auth","token":token}).encode()))
            return conn

        try:
            self.assertEqual(server.voicechat_transport(),"websocket")
            invalid=browser_socket("z"*48)
            opcode,payload=receive_frame(invalid)
            self.assertEqual(opcode,8)
            self.assertEqual(int.from_bytes(payload[:2],"big"),1008)
            invalid.close()

            with patch("server._voice_upstream_socket", side_effect=connect_fixture_upstream):
                browser=browser_socket(paired["token"])
                opcode,payload=receive_frame(browser)
                self.assertEqual(opcode,1)
                self.assertEqual(json.loads(payload.decode())["type"],"relay.ready")
                setup_message={"setup":{"model":"models/gemini-3.8-live","responseModalities":["AUDIO"],"tools":[]}}
                browser.sendall(masked_frame(json.dumps(setup_message).encode()))
                opcode,payload=receive_frame(browser)
                self.assertEqual(json.loads(payload.decode()),{"setupComplete":{}})
                audio_message={"realtimeInput":{"audio":{"data":"AQACAAMA","mimeType":"audio/pcm;rate=16000"}}}
                browser.sendall(masked_frame(json.dumps(audio_message).encode()))
                opcode,payload=receive_frame(browser)
                response=json.loads(payload.decode())
                self.assertEqual(response["serverContent"]["outputTranscription"]["text"],"Hello from Gemini fixture")
                self.assertTrue(upstream_done.wait(3))
                browser.close()

            self.assertIn(("setup",setup_message),upstream_events)
            self.assertIn(("audio",audio_message),upstream_events)
            request_headers=upstream_events[0][1].lower()
            self.assertNotIn("authorization:",request_headers)
            self.assertNotIn(paired["token"],request_headers)
            self.assertEqual(upstream_errors,[])
        finally:
            try: upstream_listener.close()
            except OSError: pass
            server.GEMINI_API_KEY = old_key
            thread.join(timeout=2)

if __name__ == "__main__":
    unittest.main()
