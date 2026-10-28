import { proxyActivities } from '@temporalio/workflow'
import type * as activities from './activities'

// Fail fast: a slow or unresponsive verification is reported as an error
// instead of being retried forever (Temporal's default retry policy is unlimited).
const { verifyEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    maximumAttempts: 2,
  },
})

export async function verifyEmailWorkflow(email: string): Promise<boolean> {
  return await verifyEmail(email)
}
