namespace WorkflowSecretBroker;

// This UI is a separate process. Its field value is never an IPC response or a workflow property.
internal sealed class SecretWindow : Form
{
    private readonly BrokerRequest request;
    // The edit limit exceeds the storage limit, so a long paste cannot be silently truncated to a valid different secret.
    private readonly TextBox value = new() { Width = 500, UseSystemPasswordChar = true, MaxLength = 8192 };
    private readonly CheckBox reveal = new() { Text = "显示当前输入", AutoSize = true };
    private readonly Label notice = new() { AutoSize = true, MaximumSize = new Size(500, 0) };
    private readonly FlowLayoutPanel actions = new() { AutoSize = true, WrapContents = true, Width = 500 };
    private readonly CancellationTokenSource cancellation = new();
    private bool pending;
    public BrokerResponse Response { get; private set; } = BrokerResponse.Failure("cancelled");

    public SecretWindow(BrokerRequest request)
    {
        this.request = request;
        Text = "工作流 Secret — Windows 凭据管理器";
        ClientSize = new Size(560, request.Command == "manage" ? 345 : 260);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        var layout = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            Padding = new Padding(24), AutoScroll = true,
        };
        Scope scope = request.Scope!;
        layout.Controls.Add(new Label
        {
            AutoSize = true, MaximumSize = new Size(500, 0),
            Text = $"工作流：{scope.WorkflowId}\n变量：{scope.VariableId}\n\n原值由本窗口管理，工作流和 Agent 只保留引用。",
        });
        if (request.Command == "manage")
        {
            Response = new BrokerResponse(true, State: "unchanged");
            value.PlaceholderText = "输入或粘贴新值；查看现值需要系统验证";
            reveal.CheckedChanged += (_, _) => value.UseSystemPasswordChar = !reveal.Checked;
            layout.Controls.Add(value);
            layout.Controls.Add(reveal);
            Button("查看现值", async () =>
            {
                await SystemAuthorization.RequireAsync(this, "查看此工作流 Secret 的现值");
                value.Text = CredentialStore.Read(scope);
                notice.Text = "已载入现值。可以查看、复制和编辑；关闭窗口不会修改保存值。";
            });
            Button("保存", async () =>
            {
                SecretValue.Validate(value.Text);
                await SystemAuthorization.RequireAsync(this, "保存此工作流 Secret 的新值");
                CredentialStore.Save(scope, value.Text);
                Response = new BrokerResponse(true, State: "saved");
                Finish();
            });
            Button("删除", async () =>
            {
                if (MessageBox.Show(this, "删除这个变量在本机保存的凭据？工作流里的变量声明仍会保留。", "删除 Secret",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                await SystemAuthorization.RequireAsync(this, "删除此工作流 Secret");
                CredentialStore.Delete(scope);
                Response = new BrokerResponse(true, State: "deleted");
                Finish();
            });
            notice.Text = "支持 Unicode、标点和空格，1–2048 UTF-8 字节。操作系统负责 Hello 或 PIN 验证。";
        }
        else
        {
            layout.Controls.Add(new Label
            {
                AutoSize = true, MaximumSize = new Size(500, 0),
                Text = "本次仅向 https://api.deepseek.com/user/balance 发送 GET 请求。仅状态码返回工作流，响应内容不返回。",
            });
            Button("验证并执行", async () =>
            {
                await SystemAuthorization.RequireAsync(this, "允许此工作流使用 Secret 查询 DeepSeek 账户状态");
                string token = CredentialStore.Read(scope);
                try
                {
                    int status = await ControlledTransport.ExecuteAsync(token, cancellation.Token);
                    Response = new BrokerResponse(true, StatusCode: status);
                    Finish();
                }
                finally { token = string.Empty; }
            });
        }
        var close = new Button { Text = "关闭", AutoSize = true };
        close.Click += (_, _) => Close();
        actions.Controls.Add(close);
        layout.Controls.Add(actions);
        layout.Controls.Add(notice);
        Controls.Add(layout);
        FormClosing += (_, _) =>
        {
            cancellation.Cancel();
            value.Clear();
            value.ClearUndo();
        };
        FormClosed += (_, _) => cancellation.Dispose();
    }

    private void Button(string label, Func<Task> action)
    {
        var button = new Button { Text = label, AutoSize = true };
        button.Click += async (_, _) =>
        {
            if (pending) return;
            pending = true;
            actions.Enabled = value.Enabled = reveal.Enabled = false;
            try { await action(); }
            catch (BrokerFailure error)
            {
                if (!IsDisposed) notice.Text = Message(error.Code);
                if (request.Command == "execute") Response = BrokerResponse.Failure(error.Code);
            }
            catch
            {
                if (!IsDisposed) notice.Text = Message("internal_error");
                if (request.Command == "execute") Response = BrokerResponse.Failure("internal_error");
            }
            finally
            {
                pending = false;
                if (!IsDisposed) actions.Enabled = value.Enabled = reveal.Enabled = true;
            }
        };
        actions.Controls.Add(button);
    }

    private void Finish()
    {
        value.Clear();
        value.ClearUndo();
        Close();
    }

    private static string Message(string code) => code switch
    {
        "cancelled" => "已取消系统验证，未进行本次操作。",
        "authentication_failed" => "系统验证未通过，未进行本次操作。",
        "biometric_unavailable" => "系统验证不可用，请在 Windows 设置中配置 Hello 或 PIN。",
        "item_missing" => "本机尚未保存此 Secret，可以输入新值并保存。",
        "item_invalid" => "值须为 1–2048 UTF-8 字节且不含 NUL；损坏的记录请重新配置。",
        "invalid_request" => "已保存的值不符合本次 Bearer 凭据格式；通用密码仍可正常保存。",
        "busy" => "系统验证正忙，请稍后重试。",
        "network_denied" => "请求目标或重定向不符合受控规则。",
        "network_failed" => "受控请求失败；不会自动重试。",
        "keychain_failed" => "Windows 凭据管理器操作失败；没有回退到文件保存。",
        _ => "本次操作未完成。",
    };
}
