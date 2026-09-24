export async function now() {
  const { default: dayjs } = await import("dayjs");
  return dayjs().format();
}
export const loadPlugin = (name) => import(`plugin-${name}`);
