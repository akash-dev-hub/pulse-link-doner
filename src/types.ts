export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export type ContactPreference = 'chat';

export const USER_ROLES = ['donor', 'requester', 'hospital', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type FacilityType = 'hospital' | 'blood_bank';
export type HospitalApprovalStatus = 'pending' | 'approved' | 'rejected';

export type BloodInventory = Record<BloodGroup, number>;

export interface UserRoleRecord {
  uid: string;
  email: string;
  username: string;
  role: UserRole;
  assignedBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface HospitalProfile {
  uid: string;
  ownerUsername: string;
  name: string;
  facilityType: FacilityType;
  licenseNumber: string;
  contact: string;
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
  lat: number | null;
  lng: number | null;
  status: HospitalApprovalStatus;
  reviewNote: string;
  reviewedBy: string;
  reviewedAtMs: number | null;
  inventory: BloodInventory;
  inventoryUpdatedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RankedHospital extends HospitalProfile {
  inStockForQuery: boolean;
  unitsForQuery: number;
  totalUnits: number;
  distanceKm: number | null;
}

export interface LocationValue {
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
}

export interface UserPublic {
  uid: string;
  username: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DonorPublic {
  uid: string;
  username: string;
  bloodGroup: BloodGroup;
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
  visibleInSearch: boolean;
  eligibleAfterMs: number;
  searchActiveAfterMs: number;
  contactPreference: 'chat' | 'hidden';
  approxLat: number | null;
  approxLng: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DonorPrivate {
  uid: string;
  fullName: string;
  phone: string;
  email: string;
  contactPreference: ContactPreference;
  lastDonationDate: string;
  exactLat: number | null;
  exactLng: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export const URGENCY_LEVELS = ['critical', 'urgent', 'planned'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export type RequestWorkflowStatus =
  | 'submitted'
  | 'hospital_verified'
  | 'donors_notified'
  | 'donor_accepted'
  | 'donor_verified'
  | 'contacts_shared'
  | 'donation_completed'
  | 'cancelled'
  | 'active'
  | 'fulfilled';

export type RequestResponseStatus =
  | 'donor_accepted'
  | 'donor_declined'
  | 'donor_verified'
  | 'contacts_shared'
  | 'donation_completed'
  | 'cancelled';

export interface EmergencyRequest {
  id: string;
  createdBy: string;
  createdByName: string;
  hospitalId: string;
  hospitalName: string;
  bloodGroup: BloodGroup;
  units: number;
  unitsCompleted: number;
  urgency: UrgencyLevel;
  confirmedUrgency: UrgencyLevel | null;
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
  hospitalLat: number | null;
  hospitalLng: number | null;
  notes: string;
  status: RequestWorkflowStatus;
  hospitalVerifiedAtMs: number | null;
  donorsNotifiedAtMs: number | null;
  notifiedDonorCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  fulfilledAtMs: number | null;
  cancelledAtMs: number | null;
  cancelledBy: string;
}

export interface RequestResponse {
  id: string;
  requestId: string;
  requesterUid: string;
  hospitalId: string;
  donorUid: string;
  donorUsername: string;
  bloodGroup: BloodGroup;
  status: RequestResponseStatus;
  decisionNote: string;
  verifiedBy: string;
  verifiedAtMs: number | null;
  contactsSharedAtMs: number | null;
  completedBy: string;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RequestSharedContact {
  id: string;
  requestId: string;
  requesterUid: string;
  donorUid: string;
  hospitalId: string;
  requesterUsername: string;
  donorUsername: string;
  requesterContact: string;
  donorContact: string;
  sharedBy: string;
  sharedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AppNotification {
  id: string;
  recipientId: string;
  senderId: string;
  requestId: string;
  bloodGroup: BloodGroup;
  units: number;
  urgency: UrgencyLevel;
  hospitalName: string;
  city: string;
  locality: string;
  stateName: string;
  countryName: string;
  hospitalLat: number | null;
  hospitalLng: number | null;
  sameLocality: boolean;
  read: boolean;
  createdAtMs: number;
}

export interface ChatThread {
  id: string;
  participantIds: [string, string];
  p1Uid: string;
  p2Uid: string;
  p1Username: string;
  p2Username: string;
  p1Unread: number;
  p2Unread: number;
  blockedByP1: boolean;
  blockedByP2: boolean;
  lastMessageText: string;
  lastMessageSenderId: string;
  lastMessageAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  participantIds: [string, string];
  senderId: string;
  senderUsername: string;
  text: string;
  createdAtMs: number;
}

export interface ReverseGeocodeResult {
  countryCode: string;
  countryName: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
  displayName: string;
}

export interface PinCodeLookupResult {
  pincode: string;
  localities: string[];
  district: string;
  state: string;
}

export type AccountModerationStatus = 'active' | 'pending_review' | 'suspended';

export interface AccountModerationRecord {
  uid: string;
  username: string;
  email: string;
  status: AccountModerationStatus;
  requiresAdminReview: boolean;
  deviceFlagged: boolean;
  ipFlagged: boolean;
  reportedFlagged: boolean;
  flagReasons: string[];
  deviceSignupCount24h: number;
  ipSignupCount24h: number;
  lastDeviceId: string;
  lastIpHash: string;
  reviewNote: string;
  reviewedBy: string;
  reviewedAtMs: number | null;
  flaggedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type AuthEventType = 'signup' | 'login';

export interface AuthEventLog {
  id: string;
  uid: string;
  username: string;
  email: string;
  eventType: AuthEventType;
  ipHash: string;
  deviceId: string;
  consentAccepted: boolean;
  deviceFlagged: boolean;
  ipFlagged: boolean;
  flagged: boolean;
  flagReasons: string[];
  expiresAtMs: number;
  createdAtMs: number;
}

export type ReportTargetType = 'user' | 'request' | 'message';
export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'fake_request'
  | 'suspicious_activity'
  | 'other';
export type ReportStatus = 'open' | 'approved_dismissed' | 'suspended' | 'restored';

export interface AbuseReport {
  id: string;
  reporterUid: string;
  reporterUsername: string;
  targetType: ReportTargetType;
  targetId: string;
  targetUid: string;
  targetUsername: string;
  contextId: string;
  targetPreview: string;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  reviewNote: string;
  reviewedBy: string;
  reviewedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UserRateLimit {
  uid: string;
  reqWindowStartMs: number | null;
  reqCount: number;
  msgWindowStartMs: number | null;
  msgCount: number;
  updatedAtMs: number;
}

export interface ThankYouCard {
  id: string;
  requestId: string;
  responseId: string;
  donorUid: string;
  donorUsername: string;
  bloodGroup: BloodGroup;
  donationDate: string;
  hospitalId: string;
  hospitalName: string;
  message: string;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}
