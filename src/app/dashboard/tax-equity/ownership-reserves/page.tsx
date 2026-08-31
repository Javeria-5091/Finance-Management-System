'use client';

// Canonical ownership/reserve implementation lives under Settings. Keeping
// this route as a thin alias prevents two divergent implementations from
// querying different schemas/column vocabularies.
import OwnershipReservesPage from '@/app/dashboard/settings/ownership-reserves/page';

export default function OwnershipReservesAliasPage() {
  return <OwnershipReservesPage />;
}
