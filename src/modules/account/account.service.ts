import type { AccountType } from "@prisma/client";
import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";

export type AccountInput = {
  code: string;
  name: string;
  type: AccountType;
  parentId?: string | null;
  isPostable?: boolean;
};

export function listAccounts() {
  return prisma.account.findMany({ orderBy: { code: "asc" } });
}

export async function getAccount(id: string) {
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) throw new AppError(404, "Account not found");
  return account;
}

async function assertParentOk(parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw new AppError(422, "An account cannot be its own parent");
  const parent = await prisma.account.findUnique({ where: { id: parentId } });
  if (!parent) throw new AppError(422, "Parent account not found");
  if (parent.isPostable) {
    throw new AppError(422, "Parent must be a group account (isPostable = false)");
  }
}

export async function createAccount(input: AccountInput) {
  await assertParentOk(input.parentId);
  const clash = await prisma.account.findUnique({ where: { code: input.code } });
  if (clash) throw new AppError(409, `Account code ${input.code} already exists`);
  return prisma.account.create({
    data: {
      code: input.code,
      name: input.name,
      type: input.type,
      parentId: input.parentId ?? null,
      isPostable: input.isPostable ?? true,
    },
  });
}

export type AccountPatch = Partial<AccountInput> & { isActive?: boolean };

// Once an account has journal lines, only its name and active flag may change —
// code / type / isPostable / parent define what past entries mean.
export async function updateAccount(id: string, patch: AccountPatch) {
  const account = await getAccount(id);
  const structural =
    patch.code !== undefined ||
    patch.type !== undefined ||
    patch.isPostable !== undefined ||
    patch.parentId !== undefined;

  if (structural) {
    const used = await prisma.journalLine.count({ where: { accountId: id } });
    if (used > 0) {
      throw new AppError(409, "Account already has journal entries: only name and isActive can change");
    }
    if (patch.parentId !== undefined) await assertParentOk(patch.parentId, id);
    if (patch.code !== undefined && patch.code !== account.code) {
      const clash = await prisma.account.findUnique({ where: { code: patch.code } });
      if (clash) throw new AppError(409, `Account code ${patch.code} already exists`);
    }
  }

  return prisma.account.update({
    where: { id },
    data: {
      code: patch.code,
      name: patch.name,
      type: patch.type,
      parentId: patch.parentId,
      isPostable: patch.isPostable,
      isActive: patch.isActive,
    },
  });
}

// Accounts are never deleted: deactivate instead (history must stay readable).
export async function deleteAccount(id: string) {
  await getAccount(id);
  const used = await prisma.journalLine.count({ where: { accountId: id } });
  if (used > 0) {
    throw new AppError(409, "Account has journal entries and cannot be deleted — deactivate it instead");
  }
  const children = await prisma.account.count({ where: { parentId: id } });
  if (children > 0) throw new AppError(409, "Account has child accounts");
  await prisma.account.delete({ where: { id } });
}
