// EdgeOne Pages Function: /api/rsvp
// Stores wedding RSVP submissions into a Feishu (Lark) Bitable, keyed by name.
// Resubmitting with the same name updates the existing record instead of
// creating a duplicate, which is how guests "edit" their registration.

const FEISHU_HOST = "https://open.feishu.cn";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "请求格式错误" }, 400);
  }

  const name = (body.name || "").trim();
  const attend = (body.attend || "").trim();
  const city = (body.city || "上海").trim();
  const note = (body.note || "").trim();
  const count = Number(body.count) || 1;

  if (!name) {
    return jsonResponse({ ok: false, error: "姓名不能为空" }, 400);
  }

  const requiredEnv = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_APP_TOKEN",
    "FEISHU_TABLE_ID",
  ];
  const missing = requiredEnv.filter((key) => !env[key]);
  if (missing.length) {
    return jsonResponse(
      { ok: false, error: "服务端未配置：" + missing.join(", ") },
      500
    );
  }

  const fields = {
    姓名: name,
    是否出席: attend || "出席",
    出席人数: count,
    所在城市: city,
    备注: note,
  };

  try {
    const token = await getTenantAccessToken(env);
    const existing = await findRecordByName(env, token, name);

    if (existing) {
      await updateRecord(env, token, existing.record_id, fields);
      return jsonResponse({ ok: true, mode: "updated" });
    }
    await createRecord(env, token, fields);
    return jsonResponse({ ok: true, mode: "created" });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) }, 502);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function getTenantAccessToken(env) {
  const res = await fetch(
    `${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: env.FEISHU_APP_ID,
        app_secret: env.FEISHU_APP_SECRET,
      }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error("获取飞书 access token 失败: " + data.msg);
  }
  return data.tenant_access_token;
}

async function findRecordByName(env, token, name) {
  const url = `${FEISHU_HOST}/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/search`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      filter: {
        conjunction: "and",
        conditions: [
          { field_name: "姓名", operator: "is", value: [name] },
        ],
      },
      page_size: 1,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error("查询登记记录失败: " + data.msg);
  }
  const items = data.data && data.data.items;
  return items && items.length > 0 ? items[0] : null;
}

async function createRecord(env, token, fields) {
  const url = `${FEISHU_HOST}/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error("新增登记记录失败: " + data.msg);
  }
}

async function updateRecord(env, token, recordId, fields) {
  const url = `${FEISHU_HOST}/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/${recordId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error("更新登记记录失败: " + data.msg);
  }
}
