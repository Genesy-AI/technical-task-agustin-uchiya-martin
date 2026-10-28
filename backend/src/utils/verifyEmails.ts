import type { PrismaClient } from '@prisma/client'
import type { WorkflowClient } from '@temporalio/client'
import { verifyEmailWorkflow } from '../workflows'

// Upper bound for a single verification, covering all activity retries.
export const VERIFY_EMAIL_TIMEOUT = '15 seconds'

export type VerifyEmailsResult = {
  verifiedCount: number
  results: Array<{ leadId: number; emailVerified: boolean }>
  errors: Array<{ leadId: number; leadName: string; error: string }>
}

export type VerifyEmailsDeps = {
  prisma: Pick<PrismaClient, 'lead'>
  workflowClient: Pick<WorkflowClient, 'execute'>
}

// Returns the unique lead IDs, or null if the input is not a non-empty array of positive integers.
export function parseLeadIds(input: unknown): number[] | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null
  }

  const ids = input.map((id) => Number(id))
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return null
  }

  return [...new Set(ids)]
}

// Temporal wraps failures (WorkflowFailedError -> ActivityFailure -> TimeoutFailure),
// so surface the innermost message, e.g. "activity StartToClose timeout".
export function getRootErrorMessage(error: unknown): string {
  let current = error
  while (current instanceof Error && (current as { cause?: unknown }).cause instanceof Error) {
    current = (current as { cause?: unknown }).cause
  }
  return current instanceof Error ? current.message : 'Unknown error'
}

// Returns null when none of the requested leads exist.
export async function verifyLeadEmails(
  leadIds: number[],
  { prisma, workflowClient }: VerifyEmailsDeps
): Promise<VerifyEmailsResult | null> {
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } } })

  if (leads.length === 0) {
    return null
  }

  // Verify all leads in parallel so one slow verification can't block the rest of the batch.
  const outcomes = await Promise.allSettled(
    leads.map(async (lead) => {
      const isVerified = Boolean(
        await workflowClient.execute(verifyEmailWorkflow, {
          taskQueue: 'myQueue',
          // One workflow per lead: concurrent requests for the same lead attach to the running
          // verification instead of starting a duplicate. Once it closes, a new run can start.
          workflowId: `verify-email-${lead.id}`,
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowExecutionTimeout: VERIFY_EMAIL_TIMEOUT,
          args: [lead.email],
        })
      )

      await prisma.lead.update({
        where: { id: lead.id },
        data: { emailVerified: isVerified },
      })

      return isVerified
    })
  )

  const results: VerifyEmailsResult['results'] = []
  const errors: VerifyEmailsResult['errors'] = []

  outcomes.forEach((outcome, index) => {
    const lead = leads[index]
    if (outcome.status === 'fulfilled') {
      results.push({ leadId: lead.id, emailVerified: outcome.value })
    } else {
      console.error(`Error verifying email for lead ${lead.id}:`, outcome.reason)
      errors.push({
        leadId: lead.id,
        leadName: `${lead.firstName} ${lead.lastName}`.trim(),
        error: getRootErrorMessage(outcome.reason),
      })
    }
  })

  // Report requested leads that no longer exist (e.g. deleted in another tab) instead of dropping them.
  const foundIds = new Set(leads.map((lead) => lead.id))
  for (const leadId of leadIds) {
    if (!foundIds.has(leadId)) {
      errors.push({ leadId, leadName: `Lead #${leadId}`, error: 'Lead not found' })
    }
  }

  return { verifiedCount: results.length, results, errors }
}
