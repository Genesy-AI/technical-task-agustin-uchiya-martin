import { describe, it, expect, vi } from 'vitest'

const { proxyActivities, verifyEmail } = vi.hoisted(() => {
  const verifyEmail = vi.fn()
  return { verifyEmail, proxyActivities: vi.fn(() => ({ verifyEmail })) }
})

vi.mock('@temporalio/workflow', () => ({ proxyActivities }))

import { verifyEmailWorkflow } from './workflows'

describe('verifyEmailWorkflow', () => {
  it('should bound the activity with a timeout and a limited number of retries', () => {
    expect(proxyActivities).toHaveBeenCalledWith({
      startToCloseTimeout: '5 seconds',
      retry: { maximumAttempts: 2 },
    })
  })

  it('should return the result of the verifyEmail activity', async () => {
    verifyEmail.mockResolvedValue(false)

    expect(await verifyEmailWorkflow('john.doe@example.com')).toBe(false)
    expect(verifyEmail).toHaveBeenCalledWith('john.doe@example.com')
  })
})
