declare const OPAQUE_LADYBUG_AUTHORITY: unique symbol;

export type OpaqueLadybugAuthority<Tag extends string> = {
  readonly [OPAQUE_LADYBUG_AUTHORITY]: Tag;
};

function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep(Reflect.get(value, key));
    }
    Object.freeze(value);
  }
  return value;
}

export function createOpaqueLadybugAuthorityIssuer<
  State extends object,
  Tag extends string,
>(invalidMessage: string): {
  issue(state: State): OpaqueLadybugAuthority<Tag>;
  consume(authority: unknown): Readonly<State>;
} {
  const states = new WeakMap<object, Readonly<State>>();
  return Object.freeze({
    issue(state: State): OpaqueLadybugAuthority<Tag> {
      const authority = Object.freeze(
        Object.create(null) as object,
      ) as OpaqueLadybugAuthority<Tag>;
      states.set(authority, freezeDeep(structuredClone(state)));
      return authority;
    },
    consume(authority: unknown): Readonly<State> {
      if (authority === null || typeof authority !== "object") {
        throw new Error(invalidMessage);
      }
      const state = states.get(authority);
      if (!state || !states.delete(authority)) {
        throw new Error(invalidMessage);
      }
      return state;
    },
  });
}
