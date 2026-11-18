"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";

export default function RegisterPage() {
	const router = useRouter();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		if (!/^[a-z0-9]{4,16}$/.test(username)) {
			setError("Username must be 4–16 lowercase letters or numbers.");
			return;
		}
		if (password.length < 8 || password.length > 32) {
			setError("Password must be 8–32 characters.");
			return;
		}
		if (password !== confirmPassword) {
			setError("Passwords do not match.");
			return;
		}
		setIsLoading(true);
		try {
			const response = await fetch("/api/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			if (!response.ok) {
				const data: unknown = await response.json().catch(() => null);
				setError(
					apiErrorMessage(data, "Could not create your account. Try again."),
				);
				return;
			}
			router.replace("/dashboard");
			router.refresh();
		} catch {
			setError("Network error. Check your connection.");
		} finally {
			setIsLoading(false);
		}
	}

	return (
		<AuthShell
			title="Criar sua conta"
			subtitle="Um usuário e senha para acessar o catálogo, as chaves e o playground."
			footer={
				<>
					Já tem conta?{" "}
					<Link
						href="/login"
						className="font-medium text-primary underline-offset-4 hover:underline"
					>
						Entrar
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
						placeholder="4–16 letras ou números"
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
						autoComplete="new-password"
						placeholder="8–32 caracteres"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
						minLength={8}
						maxLength={32}
						disabled={isLoading}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="confirmPassword">Confirmar senha</Label>
					<Input
						id="confirmPassword"
						name="confirmPassword"
						type="password"
						autoComplete="new-password"
						placeholder="repita a senha"
						value={confirmPassword}
						onChange={(event) => setConfirmPassword(event.target.value)}
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
					{isLoading ? "Criando conta…" : "Criar conta"}
				</Button>
			</form>
		</AuthShell>
	);
}
