// core/accounts — module public index (ACBP-P1-003; CDR-010). Personal-account provisioning + profile.
export {
  provisionPersonalAccount,
  provisionPersonalAccountWithStore,
  type ProvisionResult,
  type ProvisionOptions,
  type AccountProvisioningStore,
} from './provisioning.js';
export {
  getProfileForOwner,
  updateProfileForOwner,
  normalizeProfileUpdate,
  type AccountProfileView,
  type ProfileUpdateInput,
  type ProfileUpdateOptions,
} from './profile.js';
