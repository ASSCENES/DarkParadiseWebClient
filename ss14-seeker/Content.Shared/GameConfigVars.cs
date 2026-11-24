using Robust.Shared;
using Robust.Shared.Configuration;

namespace Content.Shared;

// DEVNOTE: This is the same as SS14's CCVars. Except it's not named CCVars as that name is 
// hot garbage.
[CVarDefs]
public sealed class GameConfigVars : CVars
{
    /// <summary>
    /// Address of the Seeker web client the game window opens. Set on the server and sent to every client, so the
    /// server decides where its players go.
    /// </summary>
    public static readonly CVarDef<string> SeekerUrl =
        CVarDef.Create("seeker.url", "http://localhost:8087/", CVar.REPLICATED | CVar.SERVER);
}
