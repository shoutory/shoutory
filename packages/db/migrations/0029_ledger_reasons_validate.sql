-- Validates the reason check of the previous file against the rows that exist (they all satisfy the shorter list it replaced).
ALTER TABLE app.operations VALIDATE CONSTRAINT operations_reason_check;
