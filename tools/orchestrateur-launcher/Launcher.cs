// Lanceur de la console orchestrateur (Caisse POS).
// Ouvre le navigateur par défaut sur la console d'administration. Rien d'autre :
// l'orchestrateur est en ligne, pas de serveur local à démarrer.
// Recompiler avec `tools/orchestrateur-launcher/build.ps1`.
using System;
using System.Diagnostics;
using System.Windows.Forms;

static class Launcher
{
    private const string ConsoleUrl = "https://elyndracaisse.vercel.app/admin";

    [STAThread]
    private static void Main()
    {
        try
        {
            Process.Start(ConsoleUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Impossible d'ouvrir la console :\n" + ex.Message,
                "Orchestrateur",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }
}
