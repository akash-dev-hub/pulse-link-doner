export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export type ContactPreference = 'chat';

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

export interface EmergencyRequest {
  id: string;
  createdBy: string;
  createdByName: string;
  bloodGroup: BloodGroup;
  units: number;
  hospitalName: string;
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
  hospitalLat: number | null;
  hospitalLng: number | null;
  contact: string;
  notes: string;
  status: 'active' | 'fulfilled';
  createdAtMs: number;
  updatedAtMs: number;
  fulfilledAtMs: number | null;
}

export interface AppNotification {
  id: string;
  recipientId: string;
  senderId: string;
  requestId: string;
  bloodGroup: BloodGroup;
  units: number;
  hospitalName: string;
  city: string;
  locality: string;
  stateName: string;
  countryName: string;
  contact: string;
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
