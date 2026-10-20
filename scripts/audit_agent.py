import os
import google.generativeai as genai
from github import Github

genai.configure(api_key=os.environ["GEMINI_API_KEY"])
gh = Github(os.environ["GITHUB_TOKEN"])

repo = gh.get_repo(os.environ["GITHUB_REPOSITORY"])

file_list = []
code_content = ""

try:
    contents = repo.get_contents("")
    while contents:
        file_content = contents.pop(0)
        if file_content.type == "dir":
            contents.extend(repo.get_contents(file_content.path))
        else:
            file_list.append(file_content.path)
            if file_content.path.endswith((".md", ".txt", ".json", ".yml", ".yaml", ".js", ".html", ".css", ".py")) and file_content.size < 50000:
                try:
                    code_content += f"\n--- Fichier: {file_content.path} ---\n{file_content.decoded_content.decode('utf-8')}\n"
                except Exception:
                    pass
except Exception as e:
    print(f"Erreur lors de la lecture du repo: {e}")

if not file_list:
    repo_description = "Le dépôt est actuellement vide."
else:
    repo_description = f"Fichiers présents dans le dépôt : {', '.join(file_list)}\n\nContenu des fichiers clés :\n{code_content}"

prompt = f"""
Agis en tant qu'architecte logiciel senior et expert en développement. 
Analyse l'état actuel de mon dépôt GitHub :
{repo_description}

Donne-moi des recommandations sur :
- L'architecture et l'organisation des fichiers pour un projet musical (web, app, ou scripts).
- Les bonnes pratiques à intégrer (README, structure, documentation).
- Des idées d'évolutions pertinentes.
"""

model = genai.GenerativeModel("gemini-2.5-flash")
response = model.generate_content(prompt)

repo.create_issue(
    title="🤖 Rapport d'audit et conseils pour mymusic",
    body=response.text
)
print("Rapport publié avec succès dans les Issues !")
