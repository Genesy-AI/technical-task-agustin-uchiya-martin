import { describe, it, expect, vi, beforeEach } from 'vitest'
import toast from 'react-hot-toast'
import {
  VERIFY_EMAILS_TOAST_ID,
  showVerifyingEmailsToast,
  dismissVerifyingEmailsToast,
  showVerifyEmailsResultToasts,
  showVerifyEmailsRequestErrorToast,
} from './verifyEmailsToasts'

vi.mock('react-hot-toast', () => ({
  default: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('verifyEmailsToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('loading toast', () => {
    it('should stay visible until dismissed instead of using the global duration', () => {
      showVerifyingEmailsToast()

      expect(toast.loading).toHaveBeenCalledWith('Verifying emails...', {
        id: VERIFY_EMAILS_TOAST_ID,
        duration: Infinity,
      })
    })

    it('should dismiss the same toast it opened', () => {
      dismissVerifyingEmailsToast()

      expect(toast.dismiss).toHaveBeenCalledWith(VERIFY_EMAILS_TOAST_ID)
    })
  })

  describe('showVerifyEmailsResultToasts', () => {
    it('should show only a success toast when every email was verified', () => {
      showVerifyEmailsResultToasts({
        success: true,
        verifiedCount: 2,
        results: [
          { leadId: 1, emailVerified: true },
          { leadId: 3, emailVerified: false },
        ],
        errors: [],
      })

      expect(toast.success).toHaveBeenCalledWith('Verified 2 emails')
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('should use the singular form for a single email', () => {
      showVerifyEmailsResultToasts({
        success: true,
        verifiedCount: 1,
        results: [{ leadId: 1, emailVerified: true }],
        errors: [{ leadId: 2, leadName: 'Jane Smith', error: 'activity StartToClose timeout' }],
      })

      expect(toast.success).toHaveBeenCalledWith('Verified 1 email')
      expect(toast.error).toHaveBeenCalledWith('Could not verify 1 email: Jane Smith')
    })

    it('should show both toasts on a partial failure, naming each failed lead', () => {
      showVerifyEmailsResultToasts({
        success: true,
        verifiedCount: 1,
        results: [{ leadId: 1, emailVerified: true }],
        errors: [
          { leadId: 2, leadName: 'Jane Smith', error: 'activity StartToClose timeout' },
          { leadId: 42, leadName: 'Lead #42', error: 'Lead not found' },
        ],
      })

      expect(toast.success).toHaveBeenCalledWith('Verified 1 email')
      expect(toast.error).toHaveBeenCalledWith('Could not verify 2 emails: Jane Smith, Lead #42')
    })

    it('should show only an error toast when every verification failed', () => {
      showVerifyEmailsResultToasts({
        success: true,
        verifiedCount: 0,
        results: [],
        errors: [{ leadId: 2, leadName: 'Jane Smith', error: 'activity StartToClose timeout' }],
      })

      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('Could not verify 1 email: Jane Smith')
    })
  })

  it('should show a generic error toast when the request fails', () => {
    showVerifyEmailsRequestErrorToast()

    expect(toast.error).toHaveBeenCalledWith('Failed to verify emails. Please try again.')
  })
})
