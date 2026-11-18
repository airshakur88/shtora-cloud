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
import { getDb } from "@/lib/env";
import { getCurrentSessionUser } from "@/lib/session";

// The landing is rendered per request, not at build time: every number on
// the page comes from D1, so a catalog change reaches the landing on the
// next deploy without a rebuild of static content.
export const dynamic = "force-dynamic";

interface LandingCatalog {
	keylessProviders: { name: string }[];
	freeModelsByProvider: { name: string; count: number }[];
	freeModelCount: number;
	freeProviderCount: number;
	totalProviderCount: number;
}

// One grouped query over the providers table (LEFT JOIN models): the
// catalog is the providers table, so direct rows such as the Anthropic
// models from migration 0005 (platform `anthropic`, not a catalog provider)
// are excluded, and the counts stay 303 models / 31 providers with models.
async function getLandingCatalog(): Promise<LandingCatalog> {
	const result = await getDb()
		.prepare(
			`SELECT p.name AS name, p.keyless AS keyless, COUNT(m.id) AS model_count
			 FROM providers p LEFT JOIN models m ON m.platform = p.id AND m.enabled = 1
			 GROUP BY p.id, p.name, p.keyless ORDER BY model_count DESC`,
		)
		.all<{ name: string; keyless: number; model_count: number }>();
	const rows = result.results;
	const freeModelsByProvider = rows
		.filter((row) => row.model_count > 0)
		.map((row) => ({ name: row.name, count: row.model_count }));
	return {
		keylessProviders: rows
			.filter((row) => row.keyless === 1)
			.map((row) => ({ name: row.name })),
		freeModelsByProvider,
		freeModelCount: freeModelsByProvider.reduce(
			(total, entry) => total + entry.count,
			0,
		),
		freeProviderCount: freeModelsByProvider.length,
		totalProviderCount: rows.length,
	};
}

function landingCapabilities({
	freeModelCount,
	freeProviderCount,
	freeModelsByProvider,
	keylessProviders,
}: LandingCatalog) {
	const keylessCount = keylessProviders.length;
	// O catálogo só lista modelos gratuitos: todo modelo do catálogo é
	// gratuito, então a contagem de "gratuitos" é a contagem total de
	// modelos por provedor.
	return [
		{
			icon: Route,
			title: "O provedor falhou. Sua integração não precisa mudar.",
			body: "Modelos canônicos shtora/<modelo> roteiam entre todos os provedores que expõem aquele modelo. Se um falhar, a requisição vai para o próximo. Só quando todos falham o cliente recebe um erro 502. O roteador ordena as alternativas pela taxa de sucesso e pela latência de cada modelo nos últimos 7 dias e pela qualidade do modelo. Use shtora/auto, o roteador curado, para permitir alternativas de modelo, ou shtora/coding para programar.",
			tag: "ROTEAMENTO",
		},
		{
			icon: KeyRound,
			title: "Suas chaves guardadas no gateway.",
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
			title: "Limites por chave, no painel.",
			body: "Limites de requisições e tokens por minuto e por dia, configurados por chave. O painel mostra o uso de cada chave.",
			tag: "CONTROLE",
		},
		{
			icon: Terminal,
			title: "Teste o modelo antes de escrever a integração.",
			body: "Playground com streaming e histórico de sessões. Explore o catálogo e compare contexto, visão e ferramentas de cada modelo.",
			tag: "PLAYGROUND",
		},
		{
			icon: Unplug,
			title: "Tudo gratuito. Sem versão paga.",
			body: `O catálogo tem ${freeModelCount} modelos gratuitos em ${freeProviderCount} provedores, como ${freeModelsByProvider
				.slice(0, 3)
				.map((entry) => entry.name)
				.join(
					", ",
				)}. ${keylessCount} deles nem pedem chave. Traga suas chaves ou use as da comunidade.`,
			tag: "SEM CUSTO",
		},
		{
			icon: LockKeyhole,
			title: "Cada requisição registrada.",
			body: "Requisições, tokens, falhas, latência e tempo até o primeiro token no painel, com as tentativas de fallback.",
			tag: "OBSERVABILIDADE",
		},
	];
}

function landingQuestions({
	freeModelCount,
	freeProviderCount,
	keylessProviders,
	totalProviderCount,
}: LandingCatalog) {
	return [
		{
			id: "keys",
			question: "Preciso ter uma chave de cada provedor?",
			answer: `Não. ${keylessProviders
				.map((provider) => provider.name)
				.join(
					", ",
				)} funcionam sem chave. O catálogo tem ${totalProviderCount} provedores, ${freeProviderCount} deles com modelos. Dá para cadastrar uma chave por vez no painel, na aba de provedores. Importar várias chaves de uma vez só existe pela API, com POST /api/keys/import e o export JSON de POST /api/keys/export; o painel não tem botão de importação nem de exportação. Para os demais, conecte só os que for usar. Disponibilidade, limites e condições seguem as regras de cada provedor.`,
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
				'Um ID canônico como "shtora/gpt-oss-120b" mantém a requisição naquele modelo lógico e roteia entre todos os provedores que o expõem. Se um falhar, vai para o próximo. Use model: "shtora/auto", o roteador curado, para permitir alternativas entre modelos compatíveis, ou "shtora/coding" para programar. O endpoint GET /v1/models lista apenas os modelos dos provedores com chave habilitada. Requisições com ferramentas, visão ou opções nativas precisam de suporte equivalente no destino.',
		},
		{
			id: "sdk",
			question: "Posso continuar com meu SDK OpenAI ou Anthropic?",
			answer:
				"Sim. Configure a URL base do Shtora e seu token unificado. A API OpenAI usa /v1/chat/completions; a API Anthropic usa /v1/messages. Recursos nativos exigem um provedor compatível; opções sem suporte retornam erro explícito.",
		},
		{
			id: "cost",
			question: "Usar o gateway custa alguma coisa?",
			answer: `Não. O Shtora não cobra nada e todos os ${freeModelCount} modelos do catálogo são gratuitos. Cada provedor aplica os próprios limites da cota gratuita, por requisições e tokens por minuto e por dia. Disponibilidade, limites e condições seguem as regras de cada provedor.`,
		},
		{
			id: "privacy",
			question: "Por onde passam meus prompts e minhas chaves?",
			answer:
				"As requisições passam pelo gateway em Cloudflare Workers e são enviadas ao provedor selecionado. As chaves ficam criptografadas em repouso. O processamento de prompts também está sujeito à política do provedor de destino.",
		},
	];
}

const FOCUS_VISIBLE =
	"focus-visible:outline-2 focus-visible:outline-[#e3ab88] focus-visible:outline-offset-[5px]";
const WRAP =
	"w-[min(1400px,calc(100%-64px))] max-[1100px]:w-[calc(100%-48px)] max-[480px]:w-[calc(100%-32px)] mx-auto";
const EYEBROW =
	"m-0 mb-5 flex items-center gap-[9px] font-[ui-monospace,Consolas,monospace] text-xs leading-[1.5] tracking-[1.4px] text-[#e3ab88] max-[480px]:text-[11px] max-[480px]:tracking-[1px]";
const H2 =
	"m-0 mb-5 text-[clamp(28px,2.8vw,40px)] leading-[1.18] font-[450] tracking-[-1.3px] max-[480px]:text-[28px] max-[480px]:tracking-[-1px]";
const INTRO_P = "m-0 max-w-[520px] text-[15.5px] leading-[1.75] text-[#aaa6a1]";
const TEXT_LINK = `inline-flex items-center gap-[10px] text-sm hover:text-[#e3ab88] ${FOCUS_VISIBLE}`;
const BUTTON = `inline-flex min-h-12 items-center justify-between gap-[22px] rounded border border-[#e3ab88] bg-[#e3ab88] px-[22px] py-3 text-sm font-[650] text-[#17120f] transition-[background-color_150ms,border-color_150ms] hover:border-[#f5c5a6] hover:bg-[#f5c5a6] ${FOCUS_VISIBLE}`;

export default async function HomePage() {
	const [user, catalog] = await Promise.all([
		getCurrentSessionUser(),
		getLandingCatalog(),
	]);
	const { keylessProviders, freeModelCount, freeProviderCount } = catalog;
	const keylessCount = keylessProviders.length;
	const capabilities = landingCapabilities(catalog);
	const questions = landingQuestions(catalog);
	return (
		<div
			className="dark bg-[#0c0d0f] font-['Segoe_UI',Arial,sans-serif] text-base leading-[1.6] text-[#eeeae5] [color-scheme:dark] selection:bg-[#e3ab88] selection:text-[#0c0d0f] motion-reduce:[&_*]:animate-none motion-reduce:[&_*]:transition-none [&_a]:no-underline [&_button]:cursor-pointer"
			lang="pt-BR"
		>
			<Link
				className="fixed top-3 left-4 z-50 -translate-y-[160%] bg-[#eeeae5] px-4 py-[10px] text-[#0c0d0f] focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-[#e3ab88] focus-visible:outline-offset-[5px]"
				href="#conteudo"
			>
				Pular para o conteúdo
			</Link>
			<header
				className={`flex h-[88px] items-center justify-between border-b border-[#2a2b2e] max-[800px]:h-[76px] ${WRAP}`}
			>
				<Link
					href="/"
					className={`inline-flex items-center gap-[10px] text-[22px] font-[650] tracking-[-1px] hover:text-[#e3ab88] max-[480px]:text-[20px] ${FOCUS_VISIBLE}`}
					aria-label="Shtora Cloud, início"
				>
					<span
						className="inline-flex h-[34px] w-8 items-center justify-center border border-[#675243] font-[Georgia,serif] text-[28px] font-bold text-[#e3ab88] italic"
						aria-hidden="true"
					>
						s.
					</span>
				</Link>
				<nav
					aria-label="Navegação principal"
					className="flex gap-9 text-sm text-[#b7b3ae] max-[800px]:gap-5 max-[480px]:hidden"
				>
					<Link
						className={`hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
						href="#recursos"
					>
						Recursos
					</Link>
					<Link
						className={`hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
						href="#integracao"
					>
						Integração
					</Link>
					<Link
						className={`hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
						href="#duvidas"
					>
						Dúvidas
					</Link>
				</nav>
				<LandingNav user={user} />
			</header>

			<main id="conteudo">
				<section
					className="relative flex min-h-[92dvh] flex-col justify-center overflow-hidden scroll-mt-7"
					aria-labelledby="hero-title"
				>
					<HeroBackground />
					<div
						className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(to_top,#0c0d0f_0%,transparent_55%)]"
						aria-hidden="true"
					/>
					<div className={`relative z-[2] pt-[120px] pb-14 ${WRAP}`}>
						<div>
							<p className={EYEBROW}>
								<span className="inline-block size-[6px] shrink-0 rounded-full bg-[#e3ab88]" />{" "}
								MODELOS GRATUITOS DE VÁRIOS PROVEDORES
							</p>
							<h1
								id="hero-title"
								className="m-0 text-[clamp(40px,4.1vw,56px)] leading-[1.1] font-medium tracking-[-2.2px] max-[1100px]:text-[clamp(38px,4.6vw,48px)] max-[1100px]:tracking-[-1.8px] max-[480px]:text-[clamp(34px,8.5vw,42px)] max-[480px]:tracking-[-1.5px]"
							>
								Grátis em vários
								<br />
								lugares.{" "}
								<span className="font-[Georgia,'Times_New_Roman',serif] font-normal tracking-[-1.8px] text-[#e3ab88] italic">
									Um só lugar.
								</span>
							</h1>
							<p className="my-6 mb-7 max-w-[580px] text-[17px] leading-[1.75] text-[#aaa6a1] max-[800px]:max-w-[550px] max-[800px]:text-base max-[480px]:text-[15px]">
								O catálogo reúne {freeModelCount} modelos gratuitos em{" "}
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
							<div className="flex flex-wrap items-center gap-6 max-[480px]:gap-[18px]">
								<Link className={BUTTON} href="/register">
									Criar minha conta{" "}
									<ArrowUpRight size={18} aria-hidden="true" />
								</Link>
								<Link className={TEXT_LINK} href="#integracao">
									Ver a integração <ArrowDown size={15} aria-hidden="true" />
								</Link>
							</div>
							<p className="mt-[18px] text-[13px] text-[#94918d] max-[480px]:text-xs">
								Sem chave para {keylessCount} provedores. Pool de chaves
								compartilhado. Sem trocar de SDK.
							</p>
						</div>
					</div>
				</section>
				<div className="w-full border-t border-[#2a2b2e] bg-[#0c0d0f]">
					<div className={WRAP}>
						<dl className="m-0 grid grid-cols-3 pt-[26px] pb-8 max-[480px]:gap-[10px]">
							<div className="border-l-0 pl-0">
								<dt className="mb-[5px] text-[13px] text-[#aaa6a1] max-[480px]:text-[11.5px]">
									Modelos gratuitos
								</dt>
								<dd className="m-0 text-[32px] font-[450] tracking-[-1px] max-[480px]:text-[26px]">
									{freeModelCount}
								</dd>
							</div>
							<div className="border-l border-[#2a2b2e] pl-[34px] max-[800px]:pl-5 max-[480px]:pl-[10px]">
								<dt className="mb-[5px] text-[13px] text-[#aaa6a1] max-[480px]:text-[11.5px]">
									Provedores sem chave
								</dt>
								<dd className="m-0 text-[32px] font-[450] tracking-[-1px] max-[480px]:text-[26px]">
									{keylessCount}
								</dd>
							</div>
							<div className="border-l border-[#2a2b2e] pl-[34px] max-[800px]:pl-5 max-[480px]:pl-[10px]">
								<dt className="mb-[5px] text-[13px] text-[#aaa6a1] max-[480px]:text-[11.5px]">
									Provedores com modelos
								</dt>
								<dd className="m-0 text-[32px] font-[450] tracking-[-1px] max-[480px]:text-[26px]">
									{freeProviderCount}
								</dd>
							</div>
						</dl>
					</div>
				</div>

				<RequestLayers />

				<section
					className={`scroll-mt-7 py-24 max-[800px]:py-[72px] ${WRAP}`}
					id="recursos"
					aria-labelledby="features-title"
				>
					<div className="mb-10">
						<p className={EYEBROW}>O QUE O GATEWAY FAZ</p>
						<h2 id="features-title" className={H2}>
							Construa sua aplicação.
							<br />
							<span className="text-[#96928d]">
								Deixe o roteamento com o gateway.
							</span>
						</h2>
						<p className={INTRO_P}>
							Uma integração com {freeProviderCount} provedores. O painel mostra
							cada requisição, cada falha e cada fallback.
						</p>
					</div>
					<div className="grid grid-cols-3 border-t border-l border-[#2a2b2e] max-[800px]:grid-cols-2 max-[480px]:grid-cols-1">
						{capabilities.map(({ icon: Icon, title, body, tag }) => (
							<article
								key={tag}
								className="border-r border-b border-[#2a2b2e] px-[22px] pt-[22px] pb-6 transition-colors duration-150 hover:bg-[#141516] max-[1100px]:px-[18px] max-[1100px]:py-5 max-[480px]:p-5"
							>
								<div className="mb-[18px] flex items-center justify-between text-[#e3ab88] max-[480px]:mb-4">
									<Icon size={20} strokeWidth={1.5} aria-hidden="true" />
									<span className="font-[ui-monospace,Consolas,monospace] text-[11.5px] tracking-[0.9px] text-[#aaa6a1]">
										{tag}
									</span>
								</div>
								<h3 className="m-0 mb-[10px] max-w-[300px] text-[17px] leading-[1.4] font-medium tracking-[-0.3px] max-[480px]:max-w-none">
									{title}
								</h3>
								<p className="m-0 text-sm leading-[1.7] text-[#aaa6a1]">
									{body}
								</p>
							</article>
						))}
					</div>
				</section>

				<section
					className="border-y border-[#2a2b2e] bg-[#121315] py-20 max-[800px]:py-16"
					aria-labelledby="why-title"
				>
					<div
						className={`grid grid-cols-[0.95fr_1.15fr] items-center gap-14 max-[1100px]:gap-[35px] max-[800px]:grid-cols-1 max-[800px]:gap-[35px] ${WRAP}`}
					>
						<div>
							<p className={EYEBROW}>GRÁTIS DO INÍCIO AO FIM</p>
							<h2 id="why-title" className={H2}>
								Comece de graça.
								<br />
								<span className="text-[#96928d]">Continue de graça.</span>
							</h2>
							<p className={INTRO_P}>
								{freeModelCount} modelos gratuitos em {freeProviderCount}{" "}
								provedores já funcionam aqui, e toda chave habilitada entra num
								pool comunitário que soma cota para todo mundo. Trocar de
								provedor acontece no gateway, não no seu código.
							</p>
							<Link href="/register" className={`${TEXT_LINK} mt-5`}>
								Centralizar minhas conexões{" "}
								<ArrowUpRight size={16} aria-hidden="true" />
							</Link>
						</div>
						<div className="grid grid-cols-2 rounded border border-[#2a2b2e] max-[480px]:grid-cols-1">
							<div className="px-[18px] py-5 max-[1100px]:px-[14px] max-[1100px]:py-[18px] max-[480px]:p-[18px]">
								<h3 className="m-0 mb-[18px] flex min-h-[30px] items-center gap-[10px] text-[14.5px] font-medium">
									Conexões espalhadas
								</h3>
								<ul className="m-0 grid list-none gap-[14px] p-0 text-[13.5px] text-[#aaa6a1]">
									<li>Credenciais em várias integrações</li>
									<li>Tratamento de falhas por provedor</li>
									<li>Cotas verificadas separadamente</li>
									<li>Uso dividido entre painéis</li>
								</ul>
							</div>
							<div className="border-l border-[#514134] bg-[#211c174d] px-[18px] py-5 max-[1100px]:px-[14px] max-[1100px]:py-[18px] max-[480px]:border-t max-[480px]:border-l-0 max-[480px]:p-[18px]">
								<h3 className="m-0 mb-[18px] flex min-h-[30px] items-center gap-[10px] text-[14.5px] font-medium text-[#e3ab88]">
									<span
										className="inline-flex h-[26px] w-[23px] items-center justify-center border border-[#675243] font-[Georgia,serif] text-[24px] font-bold text-[#e3ab88] italic"
										aria-hidden="true"
									>
										s.
									</span>{" "}
									Com Shtora Cloud
								</h3>
								<ul className="m-0 grid list-none gap-[14px] p-0 text-[13.5px] text-[#aaa6a1]">
									{[
										"Um token para sua aplicação",
										"Roteamento e fallback centralizados",
										"Limites configurados por chave",
										"Métricas no mesmo painel",
									].map((item) => (
										<li
											key={item}
											className="flex items-center gap-2 text-[#d8c5b7]"
										>
											<Check
												size={16}
												aria-hidden="true"
												className="shrink-0 text-[#e3ab88]"
											/>
											{item}
										</li>
									))}
								</ul>
							</div>
						</div>
					</div>
				</section>

				<section
					className={`grid scroll-mt-7 grid-cols-[0.85fr_1.15fr] items-center gap-16 py-24 max-[1100px]:gap-[35px] max-[800px]:grid-cols-1 max-[800px]:gap-[35px] max-[800px]:py-[72px] ${WRAP}`}
					id="integracao"
					aria-labelledby="integration-title"
				>
					<div>
						<p className={EYEBROW}>TROQUE A URL, NÃO O SDK</p>
						<h2 id="integration-title" className={H2}>
							Seu SDK continua.
							<br />
							<span className="text-[#96928d]">A URL muda.</span>
						</h2>
						<p className={INTRO_P}>
							Use seu token Shtora no lugar da chave do provedor. Peça um modelo
							canônico com <code>shtora/&lt;modelo&gt;</code> e o gateway roteia
							entre todos os provedores que expõem aquele modelo. Ou use{" "}
							<code>shtora/auto</code>, o roteador curado, ou{" "}
							<code>shtora/coding</code> para programar, para permitir
							alternativas compatíveis.
						</p>
						<ol className="mt-[30px] grid list-none gap-5 p-0">
							<li className="flex gap-4">
								<span className="pt-[3px] font-[ui-monospace,Consolas,monospace] text-xs text-[#e3ab88]">
									01
								</span>
								<div>
									<h3 className="m-0 mb-1 text-[15px] font-[550]">
										Crie sua conta
									</h3>
									<p className="m-0 text-[13.5px] text-[#aaa6a1]">
										Abra seu painel com usuário e senha.
									</p>
								</div>
							</li>
							<li className="flex gap-4">
								<span className="pt-[3px] font-[ui-monospace,Consolas,monospace] text-xs text-[#e3ab88]">
									02
								</span>
								<div>
									<h3 className="m-0 mb-1 text-[15px] font-[550]">
										Conecte seus provedores
									</h3>
									<p className="m-0 text-[13.5px] text-[#aaa6a1]">
										Cadastre chaves ou habilite opções sem chave.
									</p>
								</div>
							</li>
							<li className="flex gap-4">
								<span className="pt-[3px] font-[ui-monospace,Consolas,monospace] text-xs text-[#e3ab88]">
									03
								</span>
								<div>
									<h3 className="m-0 mb-1 text-[15px] font-[550]">
										Gere um token de acesso
									</h3>
									<p className="m-0 text-[13.5px] text-[#aaa6a1]">
										Configure a URL base e envie a primeira requisição.
									</p>
								</div>
							</li>
						</ol>
					</div>
					<IntegrationCode />
				</section>

				<section
					className={`grid scroll-mt-7 grid-cols-[0.8fr_1.2fr] gap-16 pb-24 max-[1100px]:gap-[35px] max-[800px]:grid-cols-1 max-[800px]:gap-[35px] max-[800px]:pb-[72px] ${WRAP}`}
					id="duvidas"
					aria-labelledby="faq-title"
				>
					<div>
						<p className={EYEBROW}>ANTES DA PRIMEIRA REQUISIÇÃO</p>
						<h2 id="faq-title" className={H2}>
							Sem letras
							<br />
							<span className="text-[#96928d]">miúdas.</span>
						</h2>
						<p className={INTRO_P}>
							O que o gateway resolve e o que continua com o provedor.
						</p>
					</div>
					<FaqDepthGutter items={questions} defaultOpen={["models"]} />
				</section>

				<section
					className={`flex items-center justify-between gap-[30px] border-t border-[#514134] pt-[55px] pb-[65px] max-[800px]:flex-col max-[800px]:items-start ${WRAP}`}
					aria-labelledby="final-title"
				>
					<div>
						<p className={EYEBROW}>COMEÇA GRÁTIS, COM OU SEM CHAVE</p>
						<h2 id="final-title" className={`${H2} mb-0`}>
							{freeModelCount} modelos grátis
							<br />
							<span className="font-[Georgia,serif] text-[#e3ab88] italic">
								e nenhum plano pago.
							</span>
						</h2>
					</div>
					<Link className={`${BUTTON} shrink-0`} href="/register">
						Começar com Shtora <ArrowUpRight size={20} aria-hidden="true" />
					</Link>
				</section>
			</main>
			<footer
				className={`flex items-center justify-between gap-[25px] border-t border-[#2a2b2e] pt-[25px] pb-[34px] max-[800px]:flex-wrap ${WRAP}`}
			>
				<Link
					href="/"
					className={`inline-flex items-center gap-[10px] text-[17px] font-[650] tracking-[-1px] hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
				>
					<span
						className="inline-flex h-[34px] w-8 items-center justify-center border border-[#675243] font-[Georgia,serif] text-[28px] font-bold text-[#e3ab88] italic"
						aria-hidden="true"
					>
						s.
					</span>
					<span>shtora</span>
				</Link>
				<p className="m-0 text-[13px] text-[#94918d] max-[480px]:order-3 max-[480px]:m-0 max-[480px]:w-full">
					{freeModelCount} modelos gratuitos em {freeProviderCount} provedores.
				</p>
				<div className="flex gap-[25px] text-[13px]">
					{user ? (
						<Link
							href="/dashboard"
							className={`inline-flex items-center gap-2 hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
						>
							{user.username} <ArrowUpRight size={13} aria-hidden="true" />
						</Link>
					) : (
						<>
							<Link
								className={`hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
								href="/login"
							>
								Entrar
							</Link>
							<Link
								href="/register"
								className={`inline-flex items-center gap-2 hover:text-[#e3ab88] ${FOCUS_VISIBLE}`}
							>
								Criar conta <ArrowRight size={13} aria-hidden="true" />
							</Link>
						</>
					)}
				</div>
			</footer>
		</div>
	);
}
