interface InsertResult<T> {
  data: T | null;
  error: unknown;
}

interface PostgresErrorLike {
  code?: unknown;
}

export async function createOrLoadProfile<T>(
  create: () => Promise<InsertResult<T>>,
  loadExisting: () => Promise<T | null>,
): Promise<T> {
  const { data, error } = await create();
  if (!error && data) return data;

  if (isUniqueViolation(error)) {
    const existing = await loadExisting();
    if (existing) return existing;
  }

  if (error) throw error;
  throw new Error("Profile creation did not return a profile.");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as PostgresErrorLike).code === "23505";
}
