/**
 * Secret redaction for anything that lands in a log line or the task_runs
 * audit table. This is a defence-in-depth net, NOT a guarantee — its job is to
 * stop the obvious, high-frequency leaks (a token echoed into command output,
 * an env var dumped into an error message) from being written verbatim to
 * disk where they outlive the process and end up in `phantombot task log`.
 *
 * Patterns are intentionally broad and may over-redact; that is the correct
 * trade-off for a log redactor — a redacted-but-useless log line is fine, a
 * leaked credential is not. If you add a new credential shape to the system,
 * add it here too.
 */
export function redactForLog(text: string): string {
  return (
    text
      // Prefixed provider tokens: GitHub (ghp_, github_pat_), OpenAI (sk-),
      // Slack (xoxb-/xoxp-/…).
      .replace(/\b(ghp|github_pat|sk|xox[baprs])[-_][-A-Za-z0-9_]{16,}\b/g, "$1_[REDACTED]")
      // Bare bearer tokens: "Authorization: Bearer <token>" / "Bearer <token>".
      .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
      // AWS access key IDs (AKIA/ASIA/AGPA/AIDA… + 16 base32 chars).
      .replace(/\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g, "[AWS_KEY_REDACTED]")
      // AWS secret access keys (40-char base64-ish following a secret-y label).
      .replace(
        /\b(aws_secret_access_key|aws_secret)\s*[:=]\s*([A-Za-z0-9/+=]{40})/gi,
        "$1=[REDACTED]",
      )
      // Emails — PII, not secrets, but we keep them out of logs too.
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_REDACTED]")
      // Generic NAME=value where NAME looks credential-bearing.
      .replace(
        /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|WEBHOOK|KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi,
        "$1=[REDACTED]",
      )
  );
}
