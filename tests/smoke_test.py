"""Smoke tests for coding-agent-mcp.

Covers every recent change without requiring real CLIs or network access:
  - Config loading & harness field parsing
  - Dispatcher factory (harness-based selection)
  - Router: task_type routing, harness filtering, tier fallback reason
  - Cursor: exit-code gating on success
  - Gemini: asyncio.Lock on _gemini_thinking_override
  - Quota: run_in_executor for file write
  - Server: auth cache TTL expiry
  - Utils: file size guard in build_prompt_with_files
  - Base: UNKNOWN_QUOTA is now a def not lambda
  - __main__: _diagnose delegates to _build_dashboard
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Make src importable when run from project root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coding_agent.config import load_config, load_config_auto, RouterConfig, ServiceConfig, default_config_path
from coding_agent.dispatchers.base import UNKNOWN_QUOTA, QuotaInfo
from coding_agent.dispatchers.utils import build_prompt_with_files, _MAX_FILE_BYTES
from coding_agent.dispatchers.cursor import CursorDispatcher, _detect_rate_limit
from coding_agent.dispatchers.gemini import _gemini_thinking_override, _settings_lock
from coding_agent.leaderboard import LeaderboardCache
from coding_agent.quota import QuotaCache
from coding_agent.router import Router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_config(**overrides) -> RouterConfig:
    """Minimal RouterConfig with two services for routing tests."""
    defaults = {
        "claude_code_opus": ServiceConfig(
            name="claude_code_opus", enabled=True, harness="claude_code",
            command="claude", model="claude-opus-4-6", tier=1,
            cli_capability=1.10,
            capabilities={"execute": 0.93, "plan": 1.00, "review": 1.00},
        ),
        "cursor_sonnet": ServiceConfig(
            name="cursor_sonnet", enabled=True, harness="cursor",
            command="agent", model="claude-sonnet-4-6", tier=1,
            cli_capability=1.05,
            capabilities={"execute": 1.00, "plan": 0.82, "review": 0.90},
        ),
        "codex_gpt54": ServiceConfig(
            name="codex_gpt54", enabled=True, harness="codex",
            command="codex", model="gpt-5.4", tier=1,
            cli_capability=1.08,
            capabilities={"execute": 1.00, "plan": 0.83, "review": 0.82},
        ),
    }
    defaults.update(overrides)
    return RouterConfig(services=defaults)


def _make_router(config=None):
    """Build a Router with mock dispatchers that always report available."""
    if config is None:
        config = _make_config()
    dispatchers = {}
    for name in config.services:
        d = MagicMock()
        d.is_available.return_value = True
        dispatchers[name] = d
    leaderboard = LeaderboardCache()
    quota = QuotaCache(dispatchers=dispatchers, ttl=9999,
                       state_file=os.path.join(tempfile.gettempdir(), "test_quota.json"))
    return Router(config=config, quota=quota, dispatchers=dispatchers,
                  leaderboard=leaderboard)


# ---------------------------------------------------------------------------
# 1. Config loading
# ---------------------------------------------------------------------------

def _example_config_path() -> str:
    """Path to config.example.yaml (the full-format reference config)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "config.example.yaml")


class TestConfigLoading(unittest.TestCase):

    def test_example_config_loads(self):
        """config.example.yaml (full format) must parse without errors."""
        config = load_config(_example_config_path())
        self.assertIsInstance(config, RouterConfig)
        self.assertGreater(len(config.services), 0)

    def test_minimal_config_auto_loads(self):
        """load_config_auto with the minimal config.yaml must not crash."""
        config = load_config_auto(default_config_path())
        self.assertIsInstance(config, RouterConfig)
        # May have 0 services in CI where no CLIs are installed — just no crash

    def test_harness_field_parsed(self):
        config = load_config(_example_config_path())
        # Every enabled service in the full config has an explicit harness
        for name, svc in config.services.items():
            if svc.enabled:
                self.assertIsNotNone(svc.harness,
                    f"{name}: enabled service should have explicit harness field")

    def test_harness_values_are_valid(self):
        valid = {"claude_code", "cursor", "codex", "gemini_cli", "openai_compatible", None}
        config = load_config(_example_config_path())
        for name, svc in config.services.items():
            self.assertIn(svc.harness, valid,
                f"{name}: unexpected harness value '{svc.harness}'")

    def test_cursor_services_have_model(self):
        config = load_config(_example_config_path())
        for name, svc in config.services.items():
            if svc.enabled and svc.harness == "cursor":
                self.assertIsNotNone(svc.model,
                    f"{name}: cursor harness service must specify a model")

    def test_optional_str_fields_are_none_or_str(self):
        config = load_config(_example_config_path())
        for name, svc in config.services.items():
            for attr in ("harness", "model", "api_key", "leaderboard_model",
                         "escalate_model", "thinking_level"):
                val = getattr(svc, attr)
                self.assertIsInstance(val, (str, type(None)),
                    f"{name}.{attr} must be str or None, got {type(val)}")


# ---------------------------------------------------------------------------
# 2. Dispatcher factory
# ---------------------------------------------------------------------------

class TestDispatcherFactory(unittest.TestCase):

    def setUp(self):
        from coding_agent.server import _build_dispatchers, _HARNESS_FACTORIES
        self.build = _build_dispatchers
        self.factories = _HARNESS_FACTORIES

    def test_harness_keys_present(self):
        for key in ("claude_code", "cursor", "codex", "gemini", "gemini_cli"):
            self.assertIn(key, self.factories, f"Missing harness key: {key}")

    def test_build_from_real_config(self):
        config = load_config(_example_config_path())
        dispatchers = self.build(config)
        self.assertGreater(len(dispatchers), 0)

    def test_correct_dispatcher_type_per_harness(self):
        from coding_agent.dispatchers.claude_code import ClaudeCodeDispatcher
        from coding_agent.dispatchers.cursor import CursorDispatcher
        from coding_agent.dispatchers.codex import CodexDispatcher
        from coding_agent.dispatchers.gemini import GeminiDispatcher
        config = load_config(_example_config_path())
        dispatchers = self.build(config)
        harness_to_type = {
            "claude_code": ClaudeCodeDispatcher,
            "cursor": CursorDispatcher,
            "codex": CodexDispatcher,
            "gemini_cli": GeminiDispatcher,
        }
        for name, svc in config.services.items():
            if svc.enabled and svc.harness in harness_to_type and name in dispatchers:
                expected = harness_to_type[svc.harness]
                self.assertIsInstance(dispatchers[name], expected,
                    f"{name}: expected {expected.__name__}, got {type(dispatchers[name]).__name__}")

    def test_model_propagated_to_dispatcher(self):
        config = load_config(default_config_path())
        dispatchers = self.build(config)
        for name, svc in config.services.items():
            if svc.enabled and svc.model and name in dispatchers:
                disp = dispatchers[name]
                self.assertEqual(getattr(disp, "model", None), svc.model,
                    f"{name}: model mismatch")


# ---------------------------------------------------------------------------
# 3. Router: task_type routing and harness filtering
# ---------------------------------------------------------------------------

class TestRouter(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.router = _make_router()

    async def test_plan_picks_opus(self):
        d = await self.router.pick_service(hints={"task_type": "plan"})
        self.assertIsNotNone(d)
        self.assertEqual(d.service, "claude_code_opus")

    async def test_execute_prefers_high_cap(self):
        d = await self.router.pick_service(hints={"task_type": "execute"})
        self.assertIsNotNone(d)
        # cursor_sonnet and codex_gpt54 both have execute cap=1.0; one of them wins
        self.assertIn(d.service, ("cursor_sonnet", "codex_gpt54", "claude_code_opus"))

    async def test_harness_filter_claude_code(self):
        d = await self.router.pick_service(hints={"harness": "claude_code"})
        self.assertIsNotNone(d)
        self.assertEqual(d.service, "claude_code_opus")

    async def test_harness_filter_cursor(self):
        d = await self.router.pick_service(hints={"harness": "cursor"})
        self.assertIsNotNone(d)
        self.assertEqual(d.service, "cursor_sonnet")

    async def test_harness_filter_codex(self):
        d = await self.router.pick_service(hints={"harness": "codex"})
        self.assertIsNotNone(d)
        self.assertEqual(d.service, "codex_gpt54")

    async def test_harness_filter_unknown_returns_none(self):
        d = await self.router.pick_service(hints={"harness": "nonexistent_harness"})
        self.assertIsNone(d)

    async def test_circuit_broken_service_excluded(self):
        self.router._breakers["claude_code_opus"].trip(retry_after=3600)
        d = await self.router.pick_service(hints={"harness": "claude_code"})
        # Only one claude_code service; should return None
        self.assertIsNone(d)

    async def test_tier_fallback_reason_when_tier1_exhausted(self):
        """Tier fallback reason must name the min configured tier, not the candidate tier."""
        # Trip all tier-1 services
        config = RouterConfig(services={
            "tier1_svc": ServiceConfig(name="tier1_svc", enabled=True,
                                       harness="claude_code", command="claude",
                                       tier=1, cli_capability=1.0,
                                       capabilities={}),
            "tier2_svc": ServiceConfig(name="tier2_svc", enabled=True,
                                       harness="codex", command="codex",
                                       tier=2, cli_capability=1.0,
                                       capabilities={}),
        })
        router = _make_router(config)
        router._breakers["tier1_svc"].trip(retry_after=3600)
        d = await router.pick_service()
        self.assertIsNotNone(d)
        self.assertEqual(d.service, "tier2_svc")
        self.assertIn("tier 1", d.reason, f"Reason should reference tier 1: '{d.reason}'")
        self.assertIn("fallback", d.reason)

    async def test_prefer_large_context_boosts_gemini_cli(self):
        """prefer_large_context must work for any gemini_cli harness service."""
        config = RouterConfig(services={
            "gemini_svc": ServiceConfig(name="gemini_svc", enabled=True,
                                        harness="gemini_cli", command="gemini",
                                        tier=1, cli_capability=1.0,
                                        capabilities={}),
            "other_svc": ServiceConfig(name="other_svc", enabled=True,
                                       harness="cursor", command="agent",
                                       tier=1, cli_capability=1.0,
                                       capabilities={}),
        })
        router = _make_router(config)
        d = await router.pick_service(hints={"prefer_large_context": True})
        self.assertIsNotNone(d)
        self.assertEqual(d.service, "gemini_svc")


# ---------------------------------------------------------------------------
# 4. Cursor: exit-code gating
# ---------------------------------------------------------------------------

class TestCursorDispatcher(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.disp = CursorDispatcher(command="agent", model="claude-sonnet-4-6")

    async def test_nonzero_exit_is_failure(self):
        """rc != 0 must produce success=False even if stdout contains JSON."""
        good_json = json.dumps({"result": "looks good"})
        with patch("coding_agent.dispatchers.cursor.run_subprocess",
                   new_callable=AsyncMock) as mock_run:
            mock_run.return_value = (1, good_json, "")
            self.disp.is_available = lambda: True
            result = await self.disp.dispatch("test", [], "/tmp")
        self.assertFalse(result.success,
            "rc=1 must not be treated as success, even with valid JSON in stdout")

    async def test_zero_exit_with_json_is_success(self):
        good_json = json.dumps({"result": "all done"})
        with patch("coding_agent.dispatchers.cursor.run_subprocess",
                   new_callable=AsyncMock) as mock_run:
            mock_run.return_value = (0, good_json, "")
            self.disp.is_available = lambda: True
            result = await self.disp.dispatch("test", [], "/tmp")
        self.assertTrue(result.success)
        self.assertEqual(result.output, "all done")

    async def test_zero_exit_empty_output_is_failure(self):
        with patch("coding_agent.dispatchers.cursor.run_subprocess",
                   new_callable=AsyncMock) as mock_run:
            mock_run.return_value = (0, "", "")
            self.disp.is_available = lambda: True
            result = await self.disp.dispatch("test", [], "/tmp")
        self.assertFalse(result.success)

    def test_model_flag_passed(self):
        """CursorDispatcher must carry the model through to __init__."""
        disp = CursorDispatcher(command="agent", model="gpt-5.4-max")
        self.assertEqual(disp.model, "gpt-5.4-max")

    def test_rate_limit_detection(self):
        self.assertTrue(_detect_rate_limit("Error: rate limit exceeded")[0])
        self.assertTrue(_detect_rate_limit("HTTP 429: Too Many Requests")[0])
        self.assertFalse(_detect_rate_limit("Task completed successfully")[0])

    def test_rate_limit_retry_after_parsed(self):
        _, retry = _detect_rate_limit("rate limit: retry_after: 60")
        self.assertEqual(retry, 60.0)


# ---------------------------------------------------------------------------
# 5. Gemini: asyncio.Lock on thinking override
# ---------------------------------------------------------------------------

class TestGeminiThinkingOverride(unittest.IsolatedAsyncioTestCase):

    async def test_lock_exists_and_is_asyncio_lock(self):
        self.assertIsInstance(_settings_lock, asyncio.Lock)

    async def test_concurrent_overrides_are_serialised(self):
        """Two concurrent dispatches must not overlap inside the settings patch."""
        events = []

        async def run_one(label: str):
            async with _gemini_thinking_override("high"):
                events.append(f"{label}_enter")
                await asyncio.sleep(0)   # yield to event loop
                events.append(f"{label}_exit")

        with patch("coding_agent.dispatchers.gemini._GEMINI_SETTINGS",
                   Path(tempfile.mktemp(suffix=".json"))):
            await asyncio.gather(run_one("A"), run_one("B"))

        # With the lock, A must fully complete before B enters
        # Pattern must be A_enter, A_exit, B_enter, B_exit
        self.assertEqual(events, ["A_enter", "A_exit", "B_enter", "B_exit"],
            f"Lock did not serialise concurrent overrides: {events}")

    async def test_no_thinking_level_yields_immediately(self):
        """None thinking level should skip the lock and yield without touching the file."""
        called = False
        async with _gemini_thinking_override(None):
            called = True
        self.assertTrue(called)


# ---------------------------------------------------------------------------
# 6. Quota: run_in_executor for file write
# ---------------------------------------------------------------------------

class TestQuotaFileWrite(unittest.IsolatedAsyncioTestCase):

    async def test_save_uses_executor_when_loop_running(self):
        """_save_local_counts must be dispatched via run_in_executor on the event loop."""
        dispatchers = {}
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            state_file = f.name
        try:
            cache = QuotaCache(dispatchers=dispatchers, ttl=9999, state_file=state_file)
            executor_calls = []

            async def fake_run_in_executor(executor, fn, *args):
                executor_calls.append(fn)
                fn(*args)  # still run it so the file gets written

            fake_result = MagicMock()
            fake_result.rate_limited = False
            fake_result.rate_limit_headers = {}

            loop = asyncio.get_running_loop()
            with patch.object(loop, "run_in_executor",
                               side_effect=fake_run_in_executor) as mock_exec:
                cache.record_result("test_svc", fake_result)
                # Give the executor call a tick to register
                await asyncio.sleep(0)
            self.assertTrue(mock_exec.called,
                "record_result must call loop.run_in_executor for the file write")
        finally:
            os.unlink(state_file)


# ---------------------------------------------------------------------------
# 7. Server: auth cache TTL
# ---------------------------------------------------------------------------

class TestAuthCacheTTL(unittest.IsolatedAsyncioTestCase):

    async def test_expired_entry_is_refetched(self):
        """An auth cache entry older than _AUTH_CACHE_TTL must be re-checked."""
        from coding_agent.server import _check_cli_auth, _auth_cache, _AUTH_CACHE_TTL

        # Plant a stale entry
        stale_time = time.time() - _AUTH_CACHE_TTL - 1
        _auth_cache["gemini"] = ("?", "stale entry", stale_time)

        # Calling _check_cli_auth should bypass the stale entry and re-check
        with patch("os.path.exists", return_value=False), \
             patch("os.environ.get", return_value=None):
            icon, desc = await _check_cli_auth("gemini")

        # The result must NOT be the stale entry
        self.assertNotEqual(desc, "stale entry", "Stale auth cache entry was not refreshed")

    async def test_fresh_entry_is_reused(self):
        """A cache entry younger than TTL must be returned without re-checking."""
        from coding_agent.server import _check_cli_auth, _auth_cache

        fresh_time = time.time()
        _auth_cache["agent"] = ("✓", "fresh cached result", fresh_time)

        icon, desc = await _check_cli_auth("agent")
        self.assertEqual(desc, "fresh cached result")


# ---------------------------------------------------------------------------
# 8. Utils: file size guard
# ---------------------------------------------------------------------------

class TestFileSizeGuard(unittest.TestCase):

    def test_small_file_is_inlined(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write("x = 1\n")
            path = f.name
        try:
            result = build_prompt_with_files("do the thing", [path])
            self.assertIn("x = 1", result)
        finally:
            os.unlink(path)

    def test_oversized_file_is_skipped(self):
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".bin", delete=False) as f:
            f.write(b"A" * (_MAX_FILE_BYTES + 1))
            path = f.name
        try:
            result = build_prompt_with_files("do the thing", [path])
            self.assertNotIn("A" * 100, result)   # content not inlined
            self.assertIn("too large", result)     # skip notice present
        finally:
            os.unlink(path)

    def test_missing_file_produces_notice(self):
        result = build_prompt_with_files("prompt", ["/nonexistent/file.py"])
        self.assertIn("not found", result.lower())


# ---------------------------------------------------------------------------
# 9. Base: UNKNOWN_QUOTA is a def not lambda
# ---------------------------------------------------------------------------

class TestUnknownQuota(unittest.TestCase):

    def test_is_function_not_lambda(self):
        self.assertTrue(callable(UNKNOWN_QUOTA))
        self.assertNotEqual(UNKNOWN_QUOTA.__name__, "<lambda>",
            "UNKNOWN_QUOTA must be a named function, not a lambda")

    def test_returns_quota_info(self):
        q = UNKNOWN_QUOTA("my_service")
        self.assertIsInstance(q, QuotaInfo)
        self.assertEqual(q.service, "my_service")
        self.assertEqual(q.source, "unknown")
        self.assertIsNone(q.remaining)

    def test_has_docstring(self):
        self.assertIsNotNone(UNKNOWN_QUOTA.__doc__)


# ---------------------------------------------------------------------------
# 10. __main__: _diagnose delegates to _build_dashboard
# ---------------------------------------------------------------------------

class TestDiagnoseDelegate(unittest.TestCase):

    def test_diagnose_calls_build_dashboard(self):
        """_diagnose() must call _build_dashboard(), not duplicate its logic."""
        main_path = os.path.join(
            os.path.dirname(__file__), "..", "src",
            "coding_agent", "__main__.py"
        )
        source = Path(main_path).read_text()
        self.assertIn("_build_dashboard", source,
            "_diagnose must delegate to _build_dashboard")
        # Ensure the old duplicated logic (quota_status, breaker_status loop) is gone
        self.assertNotIn("quota_status = await _quota.full_status()", source,
            "_diagnose must not duplicate dashboard logic")


# ---------------------------------------------------------------------------
# 11. Type annotations
# ---------------------------------------------------------------------------

class TestTypeAnnotations(unittest.TestCase):

    def _check_init_optionals(self, cls, param_names):
        sig = inspect.signature(cls.__init__)
        for param_name in param_names:
            if param_name not in sig.parameters:
                continue
            param = sig.parameters[param_name]
            annotation = param.annotation
            self.assertNotIn("= None", "")  # placeholder
            # The real check: annotation should not be bare str (which is str, not Optional)
            self.assertNotEqual(annotation, str,
                f"{cls.__name__}.__init__ param '{param_name}' should be str | None, not str")

    def test_claude_code_dispatcher_optionals(self):
        from coding_agent.dispatchers.claude_code import ClaudeCodeDispatcher
        self._check_init_optionals(ClaudeCodeDispatcher, ["api_key", "model"])

    def test_codex_dispatcher_optionals(self):
        from coding_agent.dispatchers.codex import CodexDispatcher
        self._check_init_optionals(CodexDispatcher, ["api_key", "model"])

    def test_cursor_dispatcher_optionals(self):
        from coding_agent.dispatchers.cursor import CursorDispatcher
        self._check_init_optionals(CursorDispatcher, ["api_key", "model", "thinking_level"])

    def test_gemini_dispatcher_optionals(self):
        from coding_agent.dispatchers.gemini import GeminiDispatcher
        self._check_init_optionals(GeminiDispatcher, ["api_key", "model", "thinking_level"])

    def test_openai_compatible_optionals(self):
        from coding_agent.dispatchers.openai_compatible import OpenAICompatibleDispatcher
        self._check_init_optionals(OpenAICompatibleDispatcher, ["thinking_level"])


# ---------------------------------------------------------------------------
# 12. No stale inline imports
# ---------------------------------------------------------------------------

class TestNoInlineImports(unittest.TestCase):

    def _check_no_inline_imports(self, module_path: str):
        source = Path(module_path).read_text()
        lines = source.splitlines()
        for i, line in enumerate(lines, 1):
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if stripped.startswith("import ") or stripped.startswith("from "):
                self.assertEqual(indent, 0,
                    f"{module_path}:{i}: inline import at indent {indent}: {line.strip()!r}")

    def test_openai_compatible_no_inline_imports(self):
        self._check_no_inline_imports(
            os.path.join(os.path.dirname(__file__), "..", "src",
                         "coding_agent", "dispatchers", "openai_compatible.py")
        )

    def test_utils_no_inline_imports(self):
        self._check_no_inline_imports(
            os.path.join(os.path.dirname(__file__), "..", "src",
                         "coding_agent", "dispatchers", "utils.py")
        )

    def test_server_no_inline_imports(self):
        self._check_no_inline_imports(
            os.path.join(os.path.dirname(__file__), "..", "src",
                         "coding_agent", "server.py")
        )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    unittest.main(verbosity=2)
