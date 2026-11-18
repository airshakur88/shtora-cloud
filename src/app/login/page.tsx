"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";

export default function LoginPage() {
	const router = useRouter();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setIsLoading(true);
		try {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			if (!response.ok) {
				const data: unknown = await response.json().catch(() => null);
				setError(
					apiErrorMessage(data, "Could not sign in. Check your credentials."),
				);
				return;
			}
			router.push("/dashboard");
			router.refresh();
		} catch {
			setError("Network error. Check your connection.");
		} finally {
			setIsLoading(false);
		}
	}

	return (
		<AuthShell
			title="Entrar na sua conta"
			subtitle="Acesse o painel para gerenciar chaves, modelos e o playground."
			footer={
				<>
					Não tem conta?{" "}
					<Link
						href="/register"
						className="font-medium text-primary underline-offset-4 hover:underline"
					>
						Criar conta
					</Link>
				</>
			}
		>
			<form onSubmit={handleSubmit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="username">Usuário</Label>
					<Input
						id="username"
						name="username"
						autoComplete="username"
						placeholder="seu-usuario"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						required
						minLength={4}
						maxLength={16}
						pattern="[a-z0-9]{4,16}"
						disabled={isLoading}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="password">Senha</Label>
					<Input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						placeholder="••••••••"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
						minLength={8}
						maxLength={32}
						disabled={isLoading}
					/>
				</div>
				{error ? (
					<p
						role="alert"
						className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
					>
						{error}
					</p>
				) : null}
				<Button type="submit" className="w-full" disabled={isLoading}>
					{isLoading ? "Entrando…" : "Entrar"}
				</Button>
			</form>
		</AuthShell>
	);
}
