# Security Specification & Adversarial Test Matrix

## Data Invariants
1. **Strict PII Split**: Exact coordinates (`exactLat`, `exactLng`), hidden contact details (`phone` + `email` simultaneously), and raw `lastDonationDate` exist only in `/donors_private/{donorId}` and are readable/writable exclusively by the owning user (`donorId == request.auth.uid`).
2. **Public Projection Integrity**: `/donors_public/{donorId}` never stores `phone`, `email`, `exactLat`, `exactLng`, or `lastDonationDate`. When `visibleInSearch == false`, `preferredContactType` must be `'hidden'`, `preferredContactValue` must be `''`, and `searchActiveAfterMs` must be `9999999999999`.
3. **90-Day Eligibility Enforcement**: Non-owners can only `get` or `list` `/donors_public` documents where `visibleInSearch == true` and `searchActiveAfterMs <= request.time.toMillis()`.
4. **Request Ownership & Terminal State Lock**: Only the creator (`createdBy == request.auth.uid`) can edit or mark an emergency request `'fulfilled'`. Once `'fulfilled'`, no further updates are permitted. Units must be an integer `>= 1`.
5. **Notification Targeting Integrity**: Notifications can only be read/updated/deleted by `recipientId == request.auth.uid`. Creation requires `senderId == request.auth.uid`, an active `emergency_requests/{requestId}` owned by `senderId`, and a visible, eligible `donors_public/{recipientId}` with matching `bloodGroup` and `city`.

## Adversarial Payloads ("Dirty Dozen")
1. **PII Read Theft**: Authenticated User B attempts `get('/donors_private/userA')` -> DENIED (`donorId == request.auth.uid` fails).
2. **Private Collection Listing**: Any user attempts `list('/donors_private')` -> DENIED (`allow list: if false`).
3. **Shadow Field Injection on Public Donor**: User A writes `exactLat` or `phone` into `/donors_public/userA` -> DENIED (`hasOnly` key whitelist fails).
4. **Hidden Donor Scraping**: User B queries `/donors_public` without `where('searchActiveAfterMs', '<=', now)` -> DENIED (`allow list` evaluates `resource.data.searchActiveAfterMs <= request.time.toMillis()`).
5. **Cooldown Donor Access**: User B calls `get('/donors_public/cooldownUser')` where `eligibleAfterMs > request.time.toMillis()` -> DENIED.
6. **Hidden Contact Leak Attempt**: User A sets `visibleInSearch: false` while leaving `preferredContactValue: '9999999999'` -> DENIED (`isValidDonorPublic` requires empty contact when hidden).
7. **Unauthorized Request Fulfillment**: User B attempts `update('/emergency_requests/reqA', { status: 'fulfilled' })` -> DENIED (`existing().createdBy == request.auth.uid` fails).
8. **Post-Fulfillment Tampering**: User A attempts to revert `status: 'fulfilled'` back to `'active'` -> DENIED (`existing().status == 'active'` fails).
9. **Zero/Negative Units**: User A attempts `create('/emergency_requests/req1', { units: 0 })` -> DENIED (`units >= 1` fails).
10. **Timestamp Spoofing**: User A sets `createdAt` to a past timestamp instead of `request.time` -> DENIED (`incoming().createdAt == request.time` fails).
11. **Notification Spam**: User A sends a notification referencing a non-existent or non-matching donor -> DENIED (`get()` checks matching `bloodGroup`, `city`, and `visibleInSearch == true`).
12. **Unverified / Oversized ID Poisoning**: User submits a 200-char ID or unverified token -> DENIED (`isValidId` and `email_verified == true` fail).
