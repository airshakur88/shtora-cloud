import {
	ArrowDown,
	ArrowRight,
	ArrowUpRight,
	Check,
	KeyRound,
	LockKeyhole,
	Route,
	SlidersHorizontal,
	Terminal,
	Unplug,
	Users,
} from "lucide-react";
import Link from "next/link";
import { HeroBackground } from "@/components/hero-background";
import {
	IntegrationCode,
	RequestLayers,
} from "@/components/landing-experience";
import { LandingNav } from "@/components/landing-nav";
import { FaqDepthGutter } from "@/components/ns-ui/faq-answer-depth-gutter";
import catalog from "@/lib/models-catalog.json";
import { getCurrentSessionUser } from "@/lib/server-session";

const keylessProviders = catalog.providers.filter(
	(provider) => "keyless" in provider && provider.keyless,
);
const keylessCount = keylessProviders.length;
const isFreeModel = (modelId: string) => {
	const value = modelId.toLowerCase();
	return value.includes(":free") || value.startsWith("free/");
};
const freeModelsByProvider = catalog.providers
	.map((provider) => ({
		name: provider.name,
		count: provider.keyless
			? provider.models.length
			: provider.models.filter((model) => isFreeModel(model.id)).length,
	}))
	.filter((entry) => entry.count > 0)
	.sort((a, b) => b.count - a.count);
const freeModelCount = freeModelsByProvider.reduce(
	(total, entry) => total + entry.count,
	0,
);
const freeProviderCount = freeModelsByProvider.length;

const capabilities = [
	{
		icon: Route,
		title: "O provedor falhou. Sua integração não precisa mudar.",
		body: "Modelos canônicos shtora/<modelo> roteiam entre todos os provedores que expõem aquele modelo. Se um falhar, a requisição vai para o próximo — o erro nunca chega ao seu cliente. Seleção por prioridade, velocidade ou confiabilidade, com cooldown para chaves com falhas. Use auto para permitir alternativas de modelo.",
		tag: "ROTEAMENTO",
	},
	{
		icon: KeyRound,
		title: "Suas chaves, sem espalhar segredos.",
		body: "Credenciais dos provedores criptografadas em repouso. Sua aplicação recebe um token unificado; as chaves de origem continuam no gateway.",
		tag: "BYOK",
	},
	{
		icon: Users,
		title: "Sua chave vira cota da comunidade.",
		body: "Toda chave habilitada entra num pool compartilhado entre os usuários do gateway. Suas chaves são tentadas primeiro; se a cota delas acabar, a requisição usa as chaves da comunidade. Cada chave continua com seus próprios limites.",
		tag: "POOL COMUNITÁRIO",
	},
	{
		icon: SlidersHorizontal,
		title: "Cota tem limite. Seu gateway sabe disso.",
		body: "Limites de requisições e tokens por minuto e por dia, configurados por chave. Acompanhe o uso antes de esgotar a cota do provedor.",
		tag: "CONTROLE",
	},
	{
		icon: Terminal,
		title: "Teste o modelo antes de escrever a integração.",
		body: "Playground com streaming e histórico de sessões. Explore o catálogo, compare capacidades de contexto, visão e ferramentas e escolha o modelo adequado.",
		tag: "PLAYGROUND",
	},
	{
		icon: Unplug,
		title: "Grátis quando o provedor é grátis.",
		body: `O catálogo inclui ${freeModelCount} modelos gratuitos em ${freeProviderCount} provedores, como ${freeModelsByProvider
			.slice(0, 3)
			.map((entry) => entry.name)
			.join(
				", ",
			)}. ${keylessCount} deles nem pedem chave. Importe e exporte suas chaves; conecte pagos ou use os sem chave.`,
		tag: "SEM CUSTO",
	},
	{
		icon: LockKeyhole,
		title: "Visibilidade além de \u201cfuncionou\u201d.",
		body: "Requisições, tokens, falhas, latência, tempo até o primeiro token e economia estimada no painel. Veja também as tentativas de fallback.",
		tag: "OBSERVABILIDADE",
	},
];

const questions = [
	{
		id: "keys",
		question: "Preciso ter uma chave de cada provedor?",
		answer: `Não. ${keylessProviders
			.map((provider) => provider.name)
			.join(
				", ",
			)} funcionam sem chave. O catálogo tem ${catalog.providers.length} provedores no total — dá para importar várias chaves de uma vez (export JSON) ou cadastrar uma a uma. Para os demais, conecte só os que for usar. Disponibilidade, limites e condições seguem as regras de cada provedor.`,
	},
	{
		id: "pool",
		question: "Minha chave de provedor é usada por outros usuários?",
		answer:
			"Sim, se ela estiver habilitada. Todas as chaves habilitadas formam um pool comunitário que o roteador usa para todos os usuários. Suas chaves são tentadas primeiro; se a cota delas acabar, a requisição usa uma chave da comunidade. Cada chave continua aplicando os próprios limites (rpm/tpm/rpd/tpd), então compartilhar aumenta a capacidade total sem remover os limites individuais. Desabilite a chave para tirá-la do pool.",
	},
	{
		id: "models",
		question: "O fallback pode trocar o modelo que eu escolhi?",
		answer:
			'Um ID canônico como "shtora/gpt-oss-120b" mantém a requisição naquele modelo lógico e roteia entre todos os provedores que o expõem — se um falhar, vai para o próximo. Use model: "auto" para permitir alternativas entre modelos compatíveis. O endpoint GET /v1/models lista apenas os modelos dos provedores com chave habilitada. Requisições com ferramentas, visão ou opções nativas precisam de suporte equivalente no destino.',
	},
	{
		id: "sdk",
		question: "Posso continuar com meu SDK OpenAI ou Anthropic?",
		answer:
			"Sim. Configure a URL base do Shtora e seu token unificado. A API OpenAI usa /v1/chat/completions; a API Anthropic usa /v1/messages. Recursos nativos exigem um provedor compatível; opções sem suporte retornam erro explícito.",
	},
	{
		id: "cost",
		question: "Usar o gateway elimina o custo dos modelos?",
		answer: `Não para modelos pagos: planos e cotas continuam sendo de cada provedor. Mas o catálogo já reúne ${freeModelCount} modelos gratuitos em ${freeProviderCount} provedores, então dá para começar sem gastar nada. A economia no painel é estimativa, não desconto garantido.`,
	},
	{
		id: "privacy",
		question: "Por onde passam meus prompts e minhas chaves?",
		answer:
			"As requisições passam pelo gateway em Cloudflare Workers e são enviadas ao provedor selecionado. As chaves ficam criptografadas em repouso. O processamento de prompts também está sujeito à política do provedor de destino.",
	},
];

export default async function HomePage() {
	const user = await getCurrentSessionUser();
	return (
		<div className="landing dark" lang="pt-BR">
			<Link className="landing-skip" href="#conteudo">
				Pular para o conteúdo
			</Link>
			<header className="landing-header landing-wrap">
				<Link
					href="/"
					className="landing-brand"
					aria-label="Shtora Cloud, início"
				>
					<span className="brand-mark" aria-hidden="true">
						s.
					</span>
				</Link>
				<nav aria-label="Navegação principal">
					<Link href="#recursos">Recursos</Link>
					<Link href="#integracao">Integração</Link>
					<Link href="#duvidas">Dúvidas</Link>
				</nav>
				<LandingNav user={user} />
			</header>

			<main id="conteudo">
				<section className="landing-hero-full" aria-labelledby="hero-title">
					<HeroBackground />
					<div className="hero-overlay" aria-hidden="true" />
					<div className="landing-wrap hero-content">
						<div className="hero-copy">
							<p className="landing-eyebrow">
								<span className="status-dot" /> MODELOS GRATUITOS DE VÁRIOS
								PROVEDORES
							</p>
							<h1 id="hero-title">
								Grátis em vários
								<br />
								lugares. <span>Um só lugar.</span>
							</h1>
							<p className="hero-description">
								O catálogo reúne {catalog.providers.length} provedores e{" "}
								{catalog.providers.reduce((s, p) => s + p.models.length, 0)}{" "}
								modelos — {freeModelCount} deles gratuitos em{" "}
								{freeProviderCount} provedores, incluindo{" "}
								{keylessProviders.map((provider) => provider.name).join(", ")},
								que não pedem chave. Modelos canônicos{" "}
								<code>shtora/&lt;modelo&gt;</code> roteiam entre todos os
								provedores daquele modelo. Você cria a conta, escolhe o modelo e
								usa os endpoints compatíveis com OpenAI e Anthropic. Se um
								provedor falhar, a requisição vai para o próximo. E toda chave
								habilitada entra num pool comunitário que aumenta a cota de
								todos.
							</p>
							<div className="hero-actions">
								<Link className="landing-button" href="/register">
									Criar minha conta{" "}
									<ArrowUpRight size={18} aria-hidden="true" />
								</Link>
								<Link className="landing-text-link" href="#integracao">
									Ver a integração <ArrowDown size={15} aria-hidden="true" />
								</Link>
							</div>
							<p className="hero-note">
								Sem chave para {keylessCount} provedores. Pool de chaves
								compartilhado. Sem trocar de SDK.
							</p>
						</div>
					</div>
				</section>
				<div className="stats-band">
					<div className="landing-wrap">
						<dl className="landing-stats">
							<div>
								<dt>Modelos gratuitos</dt>
								<dd>
									{freeModelCount}
									<span> em {freeProviderCount} provedores</span>
								</dd>
							</div>
							<div>
								<dt>Provedores sem chave</dt>
								<dd>
									{keylessCount}
									<span> {keylessProviders.map((p) => p.name).join(", ")}</span>
								</dd>
							</div>
							<div>
								<dt>Provedores no catálogo</dt>
								<dd>
									{catalog.providers.length}
									<span> no total</span>
								</dd>
							</div>
						</dl>
					</div>
				</div>

				<RequestLayers />

				<section
					className="provider-band"
					aria-label="Provedores com modelos gratuitos no catálogo"
				>
					<div className="landing-wrap">
						<p>
							PROVEDORES COM MODELOS GRÁTIS
							<br />
							<strong>DIRETO NO SEU CÓDIGO.</strong>
						</p>
						<ul>
							{freeModelsByProvider.map((entry) => (
								<li key={entry.name}>
									{entry.name}
									<span>
										{entry.count}{" "}
										{entry.count === 1 ? "modelo grátis" : "modelos grátis"}
									</span>
								</li>
							))}
						</ul>
					</div>
				</section>

				<section
					className="landing-section landing-wrap"
					id="recursos"
					aria-labelledby="features-title"
				>
					<div className="section-heading">
						<p className="landing-eyebrow">O GATEWAY TRABALHA NOS BASTIDORES</p>
						<h2 id="features-title">
							Construa sua aplicação.
							<br />
							<span>Não outra camada de remendos.</span>
						</h2>
						<p>
							Uma integração para gerenciar o que muda entre provedores, sem
							esconder o que acontece nas requisições.
						</p>
					</div>
					<div className="capability-grid">
						{capabilities.map(({ icon: Icon, title, body, tag }) => (
							<article key={tag} className="capability">
								<div className="capability-label">
									<Icon size={20} strokeWidth={1.5} aria-hidden="true" />
									<span>{tag}</span>
								</div>
								<h3>{title}</h3>
								<p>{body}</p>
							</article>
						))}
					</div>
				</section>

				<section className="why-section" aria-labelledby="why-title">
					<div className="landing-wrap why-layout">
						<div>
							<p className="landing-eyebrow">POR QUE PAGAR ANTES DE TESTAR?</p>
							<h2 id="why-title">
								Comece de graça.
								<br />
								<span>Depois você escolhe.</span>
							</h2>
							<p>
								{freeModelCount} modelos gratuitos em {freeProviderCount}{" "}
								provedores já funcionam aqui, e toda chave habilitada entra num
								pool comunitário que soma cota para todo mundo. Quando precisar
								de mais, a troca de provedor acontece no gateway, não no seu
								código.
							</p>
							<Link href="/register" className="landing-text-link">
								Centralizar minhas conexões{" "}
								<ArrowUpRight size={16} aria-hidden="true" />
							</Link>
						</div>
						<div className="comparison">
							<div className="comparison-column">
								<h3>Conexões espalhadas</h3>
								<ul>
									<li>Credenciais em várias integrações</li>
									<li>Tratamento de falhas por provedor</li>
									<li>Cotas verificadas separadamente</li>
									<li>Uso dividido entre painéis</li>
								</ul>
							</div>
							<div className="comparison-column comparison-shtora">
								<h3>
									<span className="brand-mark" aria-hidden="true">
										s.
									</span>{" "}
									Com Shtora Cloud
								</h3>
								<ul>
									{[
										"Um token para sua aplicação",
										"Roteamento e fallback centralizados",
										"Limites configurados por chave",
										"Métricas no mesmo painel",
									].map((item) => (
										<li key={item}>
											<Check size={16} aria-hidden="true" />
											{item}
										</li>
									))}
								</ul>
							</div>
						</div>
					</div>
				</section>

				<section
					className="landing-section landing-wrap integration-layout"
					id="integracao"
					aria-labelledby="integration-title"
				>
					<div>
						<p className="landing-eyebrow">POUCAS LINHAS. OUTRA ROTA.</p>
						<h2 id="integration-title">
							Seu SDK continua.
							<br />
							<span>A URL muda.</span>
						</h2>
						<p>
							Use seu token Shtora no lugar da chave do provedor. Peça um modelo
							canônico com <code>shtora/&lt;modelo&gt;</code> — o gateway roteia
							entre todos os provedores que expõem aquele modelo — ou use{" "}
							<code>auto</code> para permitir alternativas compatíveis.
						</p>
						<ol className="setup-steps">
							<li>
								<span>01</span>
								<div>
									<h3>Crie sua conta</h3>
									<p>Abra seu painel com usuário e senha.</p>
								</div>
							</li>
							<li>
								<span>02</span>
								<div>
									<h3>Conecte seus provedores</h3>
									<p>Cadastre chaves ou habilite opções sem chave.</p>
								</div>
							</li>
							<li>
								<span>03</span>
								<div>
									<h3>Gere um token de acesso</h3>
									<p>Configure a URL base e envie a primeira requisição.</p>
								</div>
							</li>
						</ol>
					</div>
					<IntegrationCode />
				</section>

				<section
					className="landing-wrap faq-layout"
					id="duvidas"
					aria-labelledby="faq-title"
				>
					<div>
						<p className="landing-eyebrow">ANTES DA PRIMEIRA REQUISIÇÃO</p>
						<h2 id="faq-title">
							Sem letras
							<br />
							<span>miúdas.</span>
						</h2>
						<p>
							O que o gateway resolve.
							<br />E o que continua com o provedor.
						</p>
					</div>
					<FaqDepthGutter items={questions} defaultOpen={["models"]} />
				</section>

				<section
					className="landing-wrap final-section"
					aria-labelledby="final-title"
				>
					<div>
						<p className="landing-eyebrow">
							COMEÇA GRÁTIS, SEM CHAVE EM PARTE DOS PROVEDORES
						</p>
						<h2 id="final-title">
							{freeModelCount} modelos grátis
							<br />
							<span>esperando no catálogo.</span>
						</h2>
					</div>
					<Link className="landing-button" href="/register">
						Começar com Shtora <ArrowUpRight size={20} aria-hidden="true" />
					</Link>
				</section>
			</main>
			<footer className="landing-footer landing-wrap">
				<Link href="/" className="landing-brand">
					<span className="brand-mark" aria-hidden="true">
						s.
					</span>
					<span>
						shtora<span className="brand-cloud"> / cloud</span>
					</span>
				</Link>
				<p>
					{freeModelCount} modelos gratuitos em {freeProviderCount} provedores.
				</p>
				<div>
					<Link href="/login">Entrar</Link>
					<Link href="/register">
						Criar conta <ArrowRight size={13} aria-hidden="true" />
					</Link>
				</div>
			</footer>
		</div>
	);
}
