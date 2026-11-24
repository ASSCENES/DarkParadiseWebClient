using Content.Shared;
using Robust.Client;
using Robust.Client.UserInterface;
using Robust.Client.UserInterface.Controls;
using Robust.Client.WebView;
using Robust.Shared.Configuration;
using Robust.Shared.Network;

namespace Content.Client;

/// <summary>
/// The whole game: once connected, the window shows the Seeker web client of the address the server gives.
/// </summary>
public sealed class SeekerState : Robust.Client.State.State
{
    [Dependency] private IBaseClient _client = default!;
    [Dependency] private IConfigurationManager _cfg = default!;
    [Dependency] private IUserInterfaceManager _ui = default!;
    [Dependency] private IClientNetManager _net = default!;

    private readonly LayoutContainer _root = new();
    private readonly Label _status = new() { Text = "Подключение к серверу…" };
    private WebViewControl? _web;

    protected override void Startup()
    {
        LayoutContainer.SetAnchorPreset(_root, LayoutContainer.LayoutPreset.Wide);
        LayoutContainer.SetAnchorPreset(_status, LayoutContainer.LayoutPreset.Center);
        _root.AddChild(_status);
        _ui.StateRoot.AddChild(_root);

        _client.RunLevelChanged += OnRunLevel;
        _cfg.OnValueChanged(GameConfigVars.SeekerUrl, OnUrl);

        // Started by hand (no --connect, no launcher): the prototype's own server.
        if (_client.RunLevel == ClientRunLevel.Initialize)
            _client.ConnectToServer("localhost", 1212);
        else if (_client.RunLevel >= ClientRunLevel.Connected)
            Open();
    }

    protected override void Shutdown()
    {
        _client.RunLevelChanged -= OnRunLevel;
        _cfg.UnsubValueChanged(GameConfigVars.SeekerUrl, OnUrl);
        _root.Orphan();
    }

    private void OnRunLevel(object? sender, RunLevelChangedEventArgs args)
    {
        if (args.NewLevel >= ClientRunLevel.Connected)
            Open();
        else if (args.NewLevel == ClientRunLevel.Initialize)
            Close("Нет связи с сервером.");
    }

    private void OnUrl(string _)
    {
        if (_web != null)
            _web.Url = Address();
    }

    private string Address()
    {
        // embed=ss14: the page keeps its windows inside itself (a CEF popup would be a blank window of its own)
        var url = _cfg.GetCVar(GameConfigVars.SeekerUrl);
        url += (url.Contains('?') ? "&" : "?") + "embed=ss14";
        var name = _net.ServerChannel?.UserName;
        if (string.IsNullOrEmpty(name))
            return url;
        return url + "&ss14=" + Uri.EscapeDataString(name);
    }

    private void Open()
    {
        if (_web != null)
            return;
        _status.Visible = false;
        _web = new WebViewControl();
        LayoutContainer.SetAnchorPreset(_web, LayoutContainer.LayoutPreset.Wide);
        _root.AddChild(_web);
        _web.Url = Address();
        _web.GrabKeyboardFocus();
    }

    private void Close(string why)
    {
        _web?.Orphan();
        _web = null;
        _status.Text = why;
        _status.Visible = true;
    }
}
