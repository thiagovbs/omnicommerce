DO $$
BEGIN
    IF (SELECT count(*) FROM "Sale") <> 2
       OR NOT EXISTS (SELECT 1 FROM "Sale" WHERE "id" = 'test-paid' AND "status" = 'PAID' AND "gross" = 10.10 AND "net" = 9.09 AND "updatedAt" = '2026-01-02')
       OR NOT EXISTS (SELECT 1 FROM "SaleItem" WHERE "id" = 'test-item' AND "total" = 10.10) THEN
        RAISE EXCEPTION 'Legacy order/item data was changed';
    END IF;

    IF (SELECT count(*) FROM "SaleStatusHistory" h JOIN "Sale" s ON s."id" = h."saleId"
        WHERE h."source" = 'INITIALIZATION' AND h."toStatus" = s."status"
          AND h."version" = 0 AND h."fromStatus" IS NULL AND h."occurredAt" IS NULL
          AND h."changedById" IS NULL AND s."source" = 'MANUAL'
          AND s."statusVersion" = 0 AND s."externalUpdatedAt" IS NULL AND s."lastSyncedAt" IS NULL) <> 2 THEN
        RAISE EXCEPTION 'Initial snapshots or safe defaults are incorrect';
    END IF;
END $$;

-- Two manual entries with no event identifier must be allowed.
INSERT INTO "SaleStatusHistory" ("id", "saleId", "fromStatus", "toStatus", "source", "version", "changedById")
VALUES ('manual-1', 'test-paid', 'PAID', 'INVOICED', 'MANUAL', 1, 'test-user'),
       ('manual-2', 'test-paid', 'INVOICED', 'SHIPPED', 'MANUAL', 2, 'test-user');

-- Automated entries need no browser user. Event identity is scoped to the order.
INSERT INTO "SaleStatusHistory" ("id", "saleId", "fromStatus", "toStatus", "source", "version", "externalEventId")
VALUES ('event-1', 'test-paid', 'SHIPPED', 'DELIVERED', 'INTEGRATION', 3, 'ml:event-1'),
       ('event-2', 'test-delivered', 'DELIVERED', 'REFUNDED', 'INTEGRATION', 1, 'ml:event-1');

DO $$
BEGIN
    BEGIN
        INSERT INTO "SaleStatusHistory" ("id", "saleId", "toStatus", "source", "version")
        VALUES ('duplicate-version', 'test-paid', 'REFUNDED', 'MANUAL', 3);
        RAISE EXCEPTION 'Duplicate version was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO "SaleStatusHistory" ("id", "saleId", "toStatus", "source", "version", "externalEventId")
        VALUES ('duplicate-event', 'test-paid', 'REFUNDED', 'INTEGRATION', 4, 'ml:event-1');
        RAISE EXCEPTION 'Duplicate event was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO "SaleStatusHistory" ("id", "saleId", "toStatus", "source", "version")
        VALUES ('missing-sale', 'nonexistent', 'PAID', 'INTEGRATION', 0);
        RAISE EXCEPTION 'Orphan history was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END $$;

-- Removing an actor must not remove the order's history.
DELETE FROM "User" WHERE "id" = 'test-user';
DO $$
BEGIN
    IF (SELECT count(*) FROM "SaleStatusHistory" WHERE "id" IN ('manual-1', 'manual-2') AND "changedById" IS NULL) <> 2 THEN
        RAISE EXCEPTION 'History was lost when the user was removed';
    END IF;
END $$;

-- A failure after changing status must roll back the whole application transaction.
BEGIN;
UPDATE "Sale" SET "status" = 'REFUNDED', "statusVersion" = 4 WHERE "id" = 'test-paid';
INSERT INTO "SaleStatusHistory" ("id", "saleId", "fromStatus", "toStatus", "source", "version")
VALUES ('rolled-back', 'test-paid', 'DELIVERED', 'REFUNDED', 'INTEGRATION', 4);
ROLLBACK;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "SaleStatusHistory" WHERE "id" = 'rolled-back')
       OR NOT EXISTS (SELECT 1 FROM "Sale" WHERE "id" = 'test-paid' AND "status" = 'PAID' AND "statusVersion" = 0) THEN
        RAISE EXCEPTION 'Rollback failed';
    END IF;
END $$;

SELECT 'Order model migration checks passed' AS result;
