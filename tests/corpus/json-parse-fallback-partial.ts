// `Partial<T>` and optional members: a request whose nested required
// members are missing is accepted the way Node accepts it (the listener
// pattern: the binding is assigned inside try, read after it).
interface Deployment {
  id: string;
  name: string;
  billing: { plan: string };
}
interface Order {
  deployment: Deployment;
  owner: { id: string };
}
interface ListenerRequest {
  buildOrder: Order;
  traceCarrier?: Record<string, string>;
}

const delivered: string[] = [];

async function readBody(body: string): Promise<string> {
  return body;
}

async function handle(body: string): Promise<number> {
  const text = await readBody(body);
  let request: Partial<ListenerRequest>;
  try {
    request = JSON.parse(text) as Partial<ListenerRequest>;
  } catch {
    console.log("400 invalid JSON body");
    return 400;
  }
  const buildOrder = request.buildOrder;
  const deploymentId = buildOrder?.deployment?.id;
  if (!deploymentId) {
    console.log("400 missing buildOrder.deployment.id");
    return 400;
  }
  delivered.push(deploymentId);
  console.log("200 accepted", deploymentId, Object.keys(request).join(","));
  console.log("carrier:", request.traceCarrier?.traceparent ?? "(none)");
  try {
    console.log("plan:", buildOrder?.deployment.billing.plan);
  } catch (e) {
    console.log("plan threw:", (e as Error).message);
  }
  return 200;
}

async function main(): Promise<void> {
  await handle('{"buildOrder":{"deployment":{"id":"dpl_1","name":"n","billing":{"plan":"pro"}},"owner":{"id":"o"}}}');
  await handle('{"buildOrder":{"deployment":{"id":"dpl_2"}},"traceCarrier":{"traceparent":"00-ab"}}');
  await handle('{"buildOrder":{"deployment":{}}}');
  await handle('{"traceCarrier":{}}');
  await handle("not json");
  console.log(delivered.join(","));
}

main();
