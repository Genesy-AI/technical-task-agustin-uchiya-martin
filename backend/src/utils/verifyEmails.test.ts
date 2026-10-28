import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyEmailWorkflow } from '../workflows'
import {
  parseLeadIds,
  getRootErrorMessage,
  verifyLeadEmails,
  VERIFY_EMAIL_TIMEOUT,
  VerifyEmailsDeps,
} from './verifyEmails'

type TestLead = { id: number; firstName: string; lastName: string; email: string }

const john: TestLead = { id: 1, firstName: 'John', lastName: 'Doe', email: 'john.doe@example.com' }
const jane: TestLead = { id: 2, firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@example.com' }
const emily: TestLead = { id: 3, firstName: 'Emily', lastName: 'Johnson', email: 'emily.johnson@example.com' }

function createDeps(leads: TestLead[]) {
  const findMany = vi.fn().mockResolvedValue(leads)
  const update = vi.fn().mockResolvedValue({})
  const execute = vi.fn()
  const deps = {
    prisma: { lead: { findMany, update } },
    workflowClient: { execute },
  } as unknown as VerifyEmailsDeps
  return { deps, findMany, update, execute }
}

// Mimics how Temporal nests failures: WorkflowFailedError -> ActivityFailure -> TimeoutFailure
function temporalTimeoutError() {
  const timeout = new Error('activity StartToClose timeout')
  const activity = Object.assign(new Error('Activity task failed'), { cause: timeout })
  return Object.assign(new Error('Workflow execution failed'), { cause: activity })
}

describe('parseLeadIds', () => {
  it('should return the IDs for a valid array of positive integers', () => {
    expect(parseLeadIds([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('should accept numeric strings', () => {
    expect(parseLeadIds(['4', 5])).toEqual([4, 5])
  })

  it('should remove duplicate IDs', () => {
    expect(parseLeadIds([1, 1, 2, '2'])).toEqual([1, 2])
  })

  it('should return null for missing, empty, or non-array input', () => {
    expect(parseLeadIds(undefined)).toBeNull()
    expect(parseLeadIds(null)).toBeNull()
    expect(parseLeadIds([])).toBeNull()
    expect(parseLeadIds('1,2')).toBeNull()
    expect(parseLeadIds({ 0: 1 })).toBeNull()
  })

  it('should return null when any ID is not a positive integer', () => {
    expect(parseLeadIds([1, 'abc'])).toBeNull()
    expect(parseLeadIds([1, 2.5])).toBeNull()
    expect(parseLeadIds([0])).toBeNull()
    expect(parseLeadIds([-1])).toBeNull()
    expect(parseLeadIds([null])).toBeNull()
  })
})

describe('getRootErrorMessage', () => {
  it('should return the innermost message of a nested Temporal failure', () => {
    expect(getRootErrorMessage(temporalTimeoutError())).toBe('activity StartToClose timeout')
  })

  it('should return the message of an error without a cause', () => {
    expect(getRootErrorMessage(new Error('Connection refused'))).toBe('Connection refused')
  })

  it('should return a fallback for non-Error values', () => {
    expect(getRootErrorMessage('boom')).toBe('Unknown error')
    expect(getRootErrorMessage(undefined)).toBe('Unknown error')
  })
})

describe('verifyLeadEmails', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('should return null when none of the leads exist', async () => {
    const { deps, execute } = createDeps([])

    expect(await verifyLeadEmails([99], deps)).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })

  it('should verify every lead and save the result', async () => {
    const { deps, execute, update } = createDeps([john, emily])
    execute.mockImplementation(async (_workflow, options) => options.args[0] !== john.email)

    const result = await verifyLeadEmails([1, 3], deps)

    expect(result).toEqual({
      verifiedCount: 2,
      results: [
        { leadId: 1, emailVerified: false },
        { leadId: 3, emailVerified: true },
      ],
      errors: [],
    })
    expect(update).toHaveBeenCalledWith({ where: { id: 1 }, data: { emailVerified: false } })
    expect(update).toHaveBeenCalledWith({ where: { id: 3 }, data: { emailVerified: true } })
  })

  it('should start one deduplicated, time-bounded workflow per lead', async () => {
    const { deps, execute } = createDeps([jane])
    execute.mockResolvedValue(true)

    await verifyLeadEmails([2], deps)

    expect(execute).toHaveBeenCalledWith(verifyEmailWorkflow, {
      taskQueue: 'myQueue',
      workflowId: 'verify-email-2',
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowExecutionTimeout: VERIFY_EMAIL_TIMEOUT,
      args: ['jane.smith@example.com'],
    })
  })

  it('should use the same workflow ID when the same lead is verified twice', async () => {
    const { deps, execute } = createDeps([jane])
    execute.mockResolvedValue(true)

    await verifyLeadEmails([2], deps)
    await verifyLeadEmails([2], deps)

    const workflowIds = execute.mock.calls.map(([, options]) => options.workflowId)
    expect(workflowIds).toEqual(['verify-email-2', 'verify-email-2'])
  })

  it('should report a failed verification without blocking the other leads', async () => {
    const { deps, execute, update } = createDeps([john, jane, emily])
    execute.mockImplementation(async (_workflow, options) => {
      if (options.args[0] === jane.email) throw temporalTimeoutError()
      return true
    })

    const result = await verifyLeadEmails([1, 2, 3], deps)

    expect(result).toEqual({
      verifiedCount: 2,
      results: [
        { leadId: 1, emailVerified: true },
        { leadId: 3, emailVerified: true },
      ],
      errors: [{ leadId: 2, leadName: 'Jane Smith', error: 'activity StartToClose timeout' }],
    })
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2 } }))
  })

  it('should start all verifications in parallel instead of one after another', async () => {
    const { deps, execute } = createDeps([john, jane, emily])
    // Never resolves, like a verification that hangs.
    execute.mockReturnValue(new Promise(() => {}))

    void verifyLeadEmails([1, 2, 3], deps)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3))
  })

  it('should report an error when saving the result fails', async () => {
    const { deps, execute, update } = createDeps([john])
    execute.mockResolvedValue(true)
    update.mockRejectedValue(new Error('Record to update not found.'))

    const result = await verifyLeadEmails([1], deps)

    expect(result).toEqual({
      verifiedCount: 0,
      results: [],
      errors: [{ leadId: 1, leadName: 'John Doe', error: 'Record to update not found.' }],
    })
  })

  it('should report requested leads that were not found', async () => {
    const { deps, execute, findMany } = createDeps([john])
    execute.mockResolvedValue(true)

    const result = await verifyLeadEmails([1, 42], deps)

    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: [1, 42] } } })
    expect(result).toEqual({
      verifiedCount: 1,
      results: [{ leadId: 1, emailVerified: true }],
      errors: [{ leadId: 42, leadName: 'Lead #42', error: 'Lead not found' }],
    })
  })
})
