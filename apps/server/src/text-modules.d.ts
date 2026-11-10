/** wrangler `rules` imports *.sh files as text */
declare module "*.sh" {
  const text: string;
  export default text;
}
