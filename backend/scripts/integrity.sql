-- Data integrity checks. Each branch returns a row ONLY when something is wrong; an empty result means healthy.
-- Run:  psql "$DATABASE_URL" -At -f scripts/integrity.sql     (used by restore-drill.sh and CI)
SELECT 'unbalanced_txn' AS problem, txn_id::text AS detail FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_green) <> 0
UNION ALL SELECT 'ledger_net_not_zero', SUM(amount_green)::text FROM ledger_entries HAVING COALESCE(SUM(amount_green), 0) <> 0
UNION ALL SELECT 'missing_trigger', v.t FROM (VALUES ('ledger_no_change'), ('ledger_no_truncate'), ('ledger_balance')) v(t)
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = v.t AND NOT tgisinternal)
UNION ALL SELECT 'admin_tier_mismatch', public_id FROM users WHERE (role = 'admin') <> (admin_tier IS NOT NULL)
UNION ALL SELECT 'approved_without_verified_weight', public_id FROM collections WHERE state = 'approved' AND accepted_grams IS NULL
UNION ALL SELECT 'collection_reward_mismatch', c.public_id FROM collections c WHERE
  (SELECT COALESCE(SUM(l.amount_green),0) FROM ledger_entries l WHERE l.ref_collection = c.id AND l.account = 'user:' || c.household_id || ':pending')
    <> CASE WHEN c.state = 'pending' THEN COALESCE(c.green_awarded,0) - c.reward_reversed_green ELSE 0 END
  OR (SELECT COALESCE(SUM(l.amount_green),0) FROM ledger_entries l WHERE l.ref_collection = c.id AND l.account = 'user:' || c.household_id || ':approved')
    <> CASE WHEN c.state = 'approved' THEN COALESCE(c.green_awarded,0) - c.reward_reversed_green ELSE 0 END
UNION ALL SELECT 'commission_over_reversed', id::text FROM commissions WHERE reversed_green > green
UNION ALL SELECT 'commission_reversal_sum_mismatch', k.id::text FROM commissions k WHERE k.reversed_green <> (SELECT COALESCE(SUM(v.reverse_green+v.recoverable_green),0) FROM commission_reversals v WHERE v.commission_id = k.id) AND k.state <> 'reversed' OR (k.state='reversed' AND k.reversed_green <> k.green AND NOT EXISTS (SELECT 1 FROM commission_reversals v WHERE v.commission_id=k.id))
UNION ALL SELECT 'payout_self_approved', public_id FROM payouts WHERE approved_by = prepared_by
UNION ALL SELECT 'payout_reservation_exceeds_locked', u.public_id FROM users u WHERE (SELECT COALESCE(SUM(p.reserved_green),0) FROM payouts p WHERE p.user_id=u.id AND p.status IN ('draft','pending_approval','approved','processing')) > (SELECT COALESCE(SUM(l.amount_green),0) FROM ledger_entries l WHERE l.account='user:'||u.id||':locked')
UNION ALL SELECT 'payout_paid_without_redemption_paid', p.public_id FROM payouts p JOIN redemptions r ON r.id=p.redemption_id WHERE p.status='paid' AND r.state<>'paid'
UNION ALL SELECT 'audit_log_not_append_only', v.t FROM (VALUES ('audit_no_change'), ('audit_no_truncate')) v(t)
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = v.t AND NOT tgisinternal)
UNION ALL SELECT 'migration_history_missing', 'run: node scripts/migrate.mjs --baseline <last applied number>' WHERE to_regclass('public.schema_migrations') IS NULL;
