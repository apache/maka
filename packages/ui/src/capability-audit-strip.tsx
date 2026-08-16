import type { CapabilityAuditReport } from '@maka/core/capability-audit';
import type { UiLocale } from '@maka/core/ui-locale';
import { useUiLocale } from './locale-context.js';
import { Banner } from '@astryxdesign/core/Banner';
import { getSharedUiCopy } from './shared-ui-copy.js';

/**
 * Designer audit P1-7: this used to be a full-width "能力审计" band on both
 * the Skills and Scheduled tasks pages — engineering jargon ("3 类声明工具",
 * "自动化 0/0 启用") plus counts the page tabs already show. Healthy state
 * carried zero new information, so the strip now reports by exception:
 * render a single warning line when something needs attention (sources
 * waiting for auth / erroring, scheduled tasks that failed or were skipped
 * last run), and render nothing at all when everything is fine.
 */
export function CapabilityAuditStrip(props: { report: CapabilityAuditReport }) {
  const locale = useUiLocale();
  const copy = getSharedUiCopy(locale).capabilityAudit;
  const issues = capabilityAuditIssues(props.report, locale);
  if (issues.length === 0) return null;
  return (
    <Banner
      status="warning"
      className="maka-capability-audit-strip"
      aria-label={copy.ariaLabel}
      title={issues.join(' · ')}
    />
  );
}

export function capabilityAuditIssues(report: CapabilityAuditReport, locale: UiLocale): string[] {
  const copy = getSharedUiCopy(locale).capabilityAudit;
  const issues: string[] = [];
  if (report.summary.needsAuthSourceCount > 0) issues.push(copy.needsAuthorization(report.summary.needsAuthSourceCount));
  if (report.summary.errorSourceCount > 0) issues.push(copy.sourceErrors(report.summary.errorSourceCount));
  if (report.summary.failedScheduledTaskCount > 0) issues.push(copy.failedScheduledTasks(report.summary.failedScheduledTaskCount));
  if (report.summary.skippedScheduledTaskCount > 0) issues.push(copy.skippedScheduledTasks(report.summary.skippedScheduledTaskCount));
  return issues;
}
