export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export type ContactPreference = 'phone' | 'email';

export interface LocationValue {
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
}

export interface DonorPublic {
  uid: string;
  displayName: string;
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
  preferredContactType: ContactPreference | 'hidden';
  preferredContactValue: string;
  approxLat: number | null;
  approxLng: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DonorPrivate {
  uid: string;
  phone: string;
  email: string;
  contactPreference: ContactPreference;
  lastDonationDate: string;
  exactLat: number | null;
  exactLng: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DonorProfileFormData {
  displayName: string;
  bloodGroup: BloodGroup;
  location: LocationValue;
  phone: string;
  email: string;
  contactPreference: ContactPreference;
  lastDonationDate: string;
  visibleInSearch: boolean;
  exactLat: number | null;
  exactLng: number | null;
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

export interface EmergencyRequestFormData {
  bloodGroup: BloodGroup;
  units: number;
  hospitalName: string;
  location: LocationValue;
  hospitalLat: number | null;
  hospitalLng: number | null;
  contact: string;
  notes: string;
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
