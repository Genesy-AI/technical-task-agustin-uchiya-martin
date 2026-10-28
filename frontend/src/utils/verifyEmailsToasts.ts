import toast from 'react-hot-toast'
import { LeadsVerifyEmailsOutput } from '../api/types/leads/verifyEmails'

export const VERIFY_EMAILS_TOAST_ID = 'verify-emails'

export function showVerifyingEmailsToast() {
  // Override the global 4s duration so the toast stays until the request settles.
  toast.loading('Verifying emails...', { id: VERIFY_EMAILS_TOAST_ID, duration: Infinity })
}

export function dismissVerifyingEmailsToast() {
  toast.dismiss(VERIFY_EMAILS_TOAST_ID)
}

export function showVerifyEmailsResultToasts(data: LeadsVerifyEmailsOutput) {
  if (data.verifiedCount > 0) {
    toast.success(
      data.verifiedCount === 1
        ? `Verified ${data.verifiedCount} email`
        : `Verified ${data.verifiedCount} emails`
    )
  }

  if (data.errors.length > 0) {
    const failedNames = data.errors.map((error) => error.leadName).join(', ')
    toast.error(
      data.errors.length === 1
        ? `Could not verify 1 email: ${failedNames}`
        : `Could not verify ${data.errors.length} emails: ${failedNames}`
    )
  }
}

export function showVerifyEmailsRequestErrorToast() {
  toast.error('Failed to verify emails. Please try again.')
}
